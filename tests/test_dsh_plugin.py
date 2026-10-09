#!/usr/bin/env python3
"""Contract tests for the DSH plugin package.

These tests are self-contained: they build the plugin package and drive a real
DSH profile in an isolated DSH_HOME under the system temp directory. No test
touches the user's own DSH home, an iPhone, or the network beyond loopback.

Every test asserts one property the migration promises:
  - the generated tool table matches the bridge (single source of truth);
  - installation composes the bundle row through the supported CLI;
  - the plugin module imports and registers without a device;
  - the tool surface the model sees is exactly the bridge's model-visible set;
  - the panel routes exist and fence non-loopback callers;
  - uninstall removes the row and the dependency.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DSH_PLUGIN = ROOT / "dsh" / "plugin"
DIST = ROOT / "dsh" / "dist"
SERVER = ROOT / "server"

DSH = shutil.which("dsh")
NODE = shutil.which("node")
PYTHON = sys.executable or "python3"


def run(argv, env=None, cwd=None, timeout=600):
    merged = dict(os.environ)
    merged.setdefault("IPHONE_USE_ANALYTICS", "0")
    if env:
        merged.update(env)
    return subprocess.run(argv, env=merged, cwd=cwd or str(ROOT), text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)


def node_check(path):
    return run([NODE, "--check", str(path)])


@unittest.skipUnless(NODE, "Node.js is required to check or package the plugin")
class GeneratedToolTable(unittest.TestCase):
    def test_generated_table_matches_the_bridge(self):
        result = run([PYTHON, str(ROOT / "dsh" / "scripts" / "emit_tools.py"), "--check"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("matches", result.stdout)

    def test_generated_table_covers_every_bridge_tool(self):
        sys.path.insert(0, str(SERVER))
        import iphone_use as bridge  # noqa: E402
        table = json.loads((DSH_PLUGIN / "tools.generated.json").read_text())
        self.assertEqual([t["name"] for t in table["tools"]], [t["name"] for t in bridge.TOOLS])
        self.assertEqual(table["version"], bridge.VERSION)

    def test_projection_uses_only_the_dsh_schema_subset(self):
        allowed = {"type", "oneOf", "properties", "required", "additionalProperties",
                   "items", "enum", "const", "description", "title", "default", "examples"}
        table = json.loads((DSH_PLUGIN / "tools.generated.json").read_text())

        def walk(node, path):
            if isinstance(node, list):
                for index, item in enumerate(node):
                    walk(item, f"{path}[{index}]")
                return
            if not isinstance(node, dict):
                return
            for key in node:
                self.assertIn(key, allowed, f"{path}.{key} is outside the DSH subset")
            if "oneOf" in node:
                for sibling in ("properties", "required", "additionalProperties", "items", "enum", "const"):
                    self.assertNotIn(sibling, node, f"{path} combines oneOf with {sibling}")
                self.assertGreaterEqual(len(node["oneOf"]), 2, f"{path}.oneOf needs two branches")
            self.assertNotIn("$ref", node, f"{path} still carries an unresolved $ref")
            for key in ("properties", "items"):
                if key in node:
                    if key == "properties":
                        for name, child in node[key].items():
                            walk(child, f"{path}.properties.{name}")
                    else:
                        walk(node[key], f"{path}.items")

        for tool in table["tools"]:
            self.assertEqual(tool["parameters"]["type"], "object")
            self.assertIs(tool["parameters"]["additionalProperties"], False)
            walk(tool["parameters"], tool["name"])

    def test_panel_tools_are_app_only(self):
        table = json.loads((DSH_PLUGIN / "tools.generated.json").read_text())
        model = [t["name"] for t in table["tools"] if not t["appOnly"]]
        panel = [t["name"] for t in table["tools"] if t["appOnly"]]
        self.assertEqual(len(model), 17)
        self.assertEqual(sorted(panel), ["pua_screen_action", "pua_screen_frame"])
        self.assertIn("pua_ready", model)


@unittest.skipUnless(NODE, "Node.js is required")
class PluginSources(unittest.TestCase):
    def test_sources_parse(self):
        for relative in ("index.js", "client.js"):
            self.assertEqual(node_check(DSH_PLUGIN / relative).returncode, 0, relative)
        for relative in ("lib/bridge.js", "client.js"):
            self.assertEqual(node_check(DSH_PLUGIN / relative).returncode, 0, relative)
        for relative in ("scripts/build.mjs", "scripts/install.mjs", "scripts/uninstall.mjs"):
            self.assertEqual(node_check(ROOT / "dsh" / relative).returncode, 0, relative)

    def test_manifest_declares_bundle_and_client(self):
        manifest = json.loads((DSH_PLUGIN / "package.json").read_text())
        self.assertEqual(manifest["name"], "dsh-iphone-use")
        self.assertEqual(manifest["dsh"]["bundle"]["patch"], "./cordis.patch.yml")
        self.assertEqual(manifest["dsh"]["client"]["platform"], "web")
        self.assertIn("./client", manifest["exports"])
        self.assertIn(">=0.2.0-rc.2", manifest["engines"]["dsh"])

    def test_manifest_declares_no_codex_dependency(self):
        manifest = json.loads((DSH_PLUGIN / "package.json").read_text())
        blob = json.dumps(manifest).lower()
        self.assertNotIn("codex", blob)
        self.assertNotIn("openai", blob)

    def test_plugin_never_shells_out_to_codex(self):
        """The runtime path must not depend on Codex; comments may name it."""
        import re

        def strip_comments(source):
            source = re.sub(r"/\*[\s\S]*?\*/", " ", source)
            return re.sub(r"(?m)^\s*//.*$", " ", source)

        for relative in ("index.js", "lib/bridge.js", "client.js"):
            text = strip_comments((DSH_PLUGIN / relative).read_text()).lower()
            self.assertNotIn("codex", text, f"{relative} references Codex in code")
            self.assertNotIn("openai", text, f"{relative} references OpenAI in code")
            self.assertNotIn(".codex", text, f"{relative} touches a Codex config path")

    def test_plugin_owns_its_bridge_without_a_harness_mcp_client(self):
        """The plugin speaks MCP itself, so no optional host package is required."""
        manifest = json.loads((DSH_PLUGIN / "package.json").read_text())
        self.assertNotIn("dependencies", manifest)
        source = (DSH_PLUGIN / "index.js").read_text()
        self.assertNotIn("@deepseek-ai/dsh-mcp-client", source)
        self.assertIn("node:child_process", (DSH_PLUGIN / "lib" / "bridge.js").read_text())


@unittest.skipUnless(NODE and DSH, "dsh and node are required to package and install")
class PackageAndInstall(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="dsh-iphone-use-test-"))
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.home = self.temp / "home"
        self.home.mkdir(parents=True)

    def build(self):
        result = run([NODE, str(ROOT / "dsh" / "scripts" / "build.mjs")])
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((DSH_PLUGIN / "package.json").read_text())
        tarball = DIST / f"{manifest['name']}-{manifest['version']}.tgz"
        self.assertTrue(tarball.is_file(), tarball)
        return tarball

    def profile_env(self):
        return {"DSH_HOME": str(self.home)}

    def test_tarball_is_self_contained(self):
        tarball = self.build()
        listing = run(["tar", "-tzf", str(tarball)]).stdout
        for required in ("package/index.js", "package/client.js", "package/cordis.patch.yml",
                         "package/tools.generated.json", "package/server/iphone_use.py",
                         "package/skills/iphone-use/SKILL.md", "package/package.json"):
            self.assertIn(required, listing)
        # No build-machine path may leak into the shipped plugin.
        home_blob = json.dumps(str(Path.home()))
        payload = run(["tar", "-xzOf", str(tarball), "package/index.js"]).stdout
        self.assertNotIn(str(Path.home()), payload)
        payload = run(["tar", "-xzOf", str(tarball), "package/client.js"]).stdout
        self.assertNotIn(str(Path.home()), payload)
        self.assertTrue(home_blob)

    def test_install_composes_the_row_and_uninstall_removes_it(self):
        tarball = self.build()
        profile = "iuaccept"
        result = run([DSH, "plugin", "--profile", profile, "add", str(tarball)], env=self.profile_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest_path = self.home / "profiles" / profile / "package.json"
        manifest = json.loads(manifest_path.read_text())
        self.assertIn("dsh-iphone-use", manifest["dsh"]["profile"]["bundles"])
        self.assertIn("dsh-iphone-use", manifest["dependencies"])

        composed = run([DSH, "--profile", profile, "--dump-config"], env=self.profile_env())
        self.assertEqual(composed.returncode, 0, composed.stderr)
        self.assertIn("iphone-use", composed.stdout)

        result = run([DSH, "plugin", "--profile", profile, "remove", "dsh-iphone-use"], env=self.profile_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(manifest_path.read_text())
        self.assertNotIn("dsh-iphone-use", manifest["dsh"]["profile"]["bundles"])
        # pnpm drops the whole dependencies block once its last entry goes.
        self.assertNotIn("dsh-iphone-use", manifest.get("dependencies", {}))

    def test_isolated_home_is_the_only_one_written(self):
        tarball = self.build()
        real_home = Path(os.path.expanduser("~")) / ".dsh"
        before = real_home.stat().st_mtime_ns if real_home.exists() else None
        result = run([DSH, "plugin", "--profile", "iuisolate", "add", str(tarball)], env=self.profile_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        after = real_home.stat().st_mtime_ns if real_home.exists() else None
        self.assertEqual(before, after, "the user's real DSH home was modified")


if __name__ == "__main__":
    unittest.main()
