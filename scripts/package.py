#!/usr/bin/env python3
"""Build the shippable source tree and its source archive.

The install tree is the runtime a user needs on disk; the source archive adds the
tests, CI and developer scripts. The DSH plugin package itself is built by
dsh/scripts/build.mjs, which owns the plugin layout and the generated tool table.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[1]
FILES=('AGENTS.md','README.md','README.en.md','ANALYTICS.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md')
DIRS=('assets','dsh','server','skills')
INSTALL_SCRIPTS=('check.sh','phone.py','update_app_catalog.py','package.py')
SOURCE_DIRS=('scripts','tests','.github')
TOOLING_FILES=('package.json','package-lock.json','forward.mjs','screen-stream.mjs')


def package_files(source_package=False):
    """Local docs, evals, experiments and dependency installs are never shipped."""
    sources=[ROOT/name for name in FILES]
    for dirname in DIRS+(SOURCE_DIRS if source_package else ()):
        sources.extend((ROOT/dirname).rglob('*'))
    if source_package:
        sources.append(ROOT/'.gitignore')
    else:
        sources.extend(ROOT/'scripts'/name for name in INSTALL_SCRIPTS)
    sources.extend(ROOT/'tooling'/name for name in TOOLING_FILES)
    for source in sorted(set(sources)):
        if source.is_symlink():raise SystemExit('Refusing package symlink: '+str(source))
        if not source.is_file():continue
        rel=source.relative_to(ROOT)
        if any(part in ('__pycache__','node_modules','.pytest_cache','dist') for part in rel.parts):continue
        if source.suffix in ('.pyc','.jsonl') or source.name in ('.DS_Store','posthog.local.json'):continue
        yield source,rel


def validate():
    # The DSH plugin manifest names the package and owns its release version; the
    # Codex plugin.json it used to mirror is retired.
    manifest=json.loads((ROOT/'dsh/plugin/package.json').read_text())
    assert manifest['name']=='dsh-iphone-use' and re.fullmatch(r'\d+\.\d+\.\d+',manifest['version'])
    for skill in ('iphone-use','iphone-use-setup'):
        path=ROOT/'skills'/skill/'SKILL.md';body=path.read_text()
        assert body.startswith('---\n') and re.search(r'^name: '+skill+r'$',body,re.M) and re.search(r'^description: .+',body,re.M)
    assert (ROOT/'tooling/package-lock.json').is_file()
    sys.path.insert(0,str(ROOT/'server'))
    from iphone_use import TOOLS,VERSION
    # The bridge owns the device contract, so the generated table the host loads
    # must match it; the manifest version above is a separate release line.
    table=json.loads((ROOT/'dsh/plugin/tools.generated.json').read_text())
    assert table['version']==VERSION
    assert [t['name'] for t in table['tools']]==[t['name'] for t in TOOLS] and len(TOOLS)==19
    assert sum(t.get('_meta',{}).get('ui',{}).get('visibility')!=['app'] for t in TOOLS)==17
    assert len(set(t['name'] for t in TOOLS))==len(TOOLS)
    for t in TOOLS:assert t['inputSchema']['additionalProperties'] is False
    return manifest['version']


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--validate-only',action='store_true');parser.add_argument('--stage-only',action='store_true');args=parser.parse_args()
    version=validate()
    if args.validate_only:
        print('2 skills, 17 model tools and 2 panel tools validated.');return
    stage=ROOT/'dist'/'iphone-use'
    if stage.exists():shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for source,rel in package_files():
        target=stage/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
    if args.stage_only:print(stage);return
    archive=ROOT/'dist'/f"iphone-use-{version}-source.zip"
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for source,rel in package_files(source_package=True):
            z.write(source,str(Path('iphone-use')/rel))
    print(archive)


if __name__=='__main__':main()
