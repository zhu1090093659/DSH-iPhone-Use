import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('iphone_use_packaging', ROOT / 'scripts/package.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class PackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='iphone use package ')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name).resolve() / 'checkout'
        for source, rel in packaging.package_files(source_package=True):
            target = cls.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        # Local-only material exists on disk even when it is not Git-tracked.
        for name in ('docs/private-notes.md', 'evals/cases.json', 'plugins/experiment/private.txt'):
            target = cls.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('local-only fixture')
        (cls.root / 'server/posthog.local.json').write_text('{"projectToken":"local-only-token"}')
        subprocess.run([sys.executable, str(cls.root / 'scripts/package.py')], check=True, capture_output=True, text=True)
        cls.stage = cls.root / 'dist/iphone-use'
        cls.archive = next((cls.root / 'dist').glob('*-source.zip'))

    def test_source_and_install_exclude_local_material_without_deleting_it(self):
        with zipfile.ZipFile(self.archive) as archive:
            entries = {Path(name).relative_to('iphone-use').as_posix() for name in archive.namelist()}
        installed = {p.relative_to(self.stage).as_posix() for p in self.stage.rglob('*') if p.is_file()}
        for contents in (entries, installed):
            self.assertFalse(any(p.startswith(('docs/', 'evals/', 'plugins/')) for p in contents))
            self.assertNotIn('server/posthog.local.json', contents)
            self.assertIn('server/analytics.py', contents)
            self.assertIn('server/posthog.json', contents)
            self.assertIn('ANALYTICS.md', contents)
        self.assertIn('tests/test_packaging.py', entries)
        self.assertIn('.github/workflows/check.yml', entries)
        self.assertIn('scripts/benchmark.py', entries)
        self.assertNotIn('scripts/benchmark.py', installed)
        self.assertNotIn('scripts/smoke_mcp.py', installed)
        self.assertFalse(any(p.startswith(('tests/', '.github/')) for p in installed))
        self.assertEqual((self.root / 'docs/private-notes.md').read_text(), 'local-only fixture')
        self.assertTrue((self.root / 'evals/cases.json').is_file())

    def test_the_retired_codex_host_files_are_not_shipped(self):
        installed = {p.relative_to(self.stage).as_posix() for p in self.stage.rglob('*') if p.is_file()}
        for gone in ('plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin/plugin.json',
                     'scripts/install.sh', 'scripts/register_mcp.py', 'scripts/wda.sh'):
            self.assertNotIn(gone, installed, gone)
        # The DSH plugin package is the runtime that ships now.
        self.assertIn('dsh/plugin/index.js', installed)
        self.assertIn('dsh/scripts/build.mjs', installed)

    def test_installed_runtime_inputs_and_operational_links_are_complete(self):
        for name in ('tooling/screen-stream.mjs', 'tooling/forward.mjs',
                     'tooling/package-lock.json', 'scripts/phone.py'):
            self.assertEqual((self.stage / name).read_bytes(), (ROOT / name).read_bytes(), name)
        for document in list((self.stage / 'skills').rglob('*.md')) + [self.stage / 'README.md', self.stage / 'README.en.md', self.stage / 'CHANGELOG.md']:
            for target in re.findall(r'\]\(([^)]+)\)', document.read_text()):
                if '://' in target or target.startswith('#'):
                    continue
                linked = (document.parent / target.split('#')[0]).resolve()
                self.assertTrue(linked.is_relative_to(self.stage.resolve()), str(linked))
                self.assertTrue(linked.exists(), f'{document.relative_to(self.stage)} -> {target}')

    def test_portable_source_recreates_install_and_serves_the_bridge(self):
        checkout = Path(self.directory.name) / 'extracted source'
        with zipfile.ZipFile(self.archive) as archive:
            archive.extractall(checkout)
        source_root = checkout / 'iphone-use'
        subprocess.run([sys.executable, str(source_root / 'scripts/package.py'), '--stage-only'], check=True, capture_output=True, text=True)
        rebuilt = source_root / 'dist/iphone-use'
        expected = {p.relative_to(self.stage): p.read_bytes() for p in self.stage.rglob('*') if p.is_file()}
        actual = {p.relative_to(rebuilt): p.read_bytes() for p in rebuilt.rglob('*') if p.is_file()}
        self.assertEqual(actual, expected)
        # Read the rebuilt bridge's own version without importing it: rebinding
        # the shared iphone_use module here would break every later test that
        # patches it.
        declared = re.search(r'^VERSION="([^"]+)"', (rebuilt / 'server/iphone_use.py').read_text(), re.M).group(1)
        requests = [
            {'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'package-test', 'version': '1'}}},
            {'method': 'tools/list', 'params': {}},
            {'method': 'ping', 'params': {}},
        ]
        wire = '\n'.join(json.dumps({'jsonrpc': '2.0', 'id': i, **request}) for i, request in enumerate(requests, 1)) + '\n'
        process = subprocess.run([sys.executable, str(rebuilt / 'server/iphone_use.py')], input=wire, capture_output=True, text=True, timeout=15, check=True)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertTrue(all('error' not in reply for reply in replies), str([r.get('error') for r in replies]))
        self.assertEqual(replies[0]['result']['serverInfo']['version'], declared)
        self.assertEqual(len(replies[1]['result']['tools']), 19)
        # The retired widget resource must not come back as a promise.
        self.assertNotIn('resources', json.dumps(replies[0]['result']['capabilities']))


if __name__ == '__main__':
    unittest.main()
