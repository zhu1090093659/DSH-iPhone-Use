#!/usr/bin/env python3
"""Project the PUA tool table into the schema subset a DSH host accepts.

The Python bridge stays the single source of truth for every tool's name,
description and argument schema. Codex (MCP Apps) accepts the published schema
as-is; the DSH ToolRuntime enforces a smaller keyword subset and rejects a
schema carrying anything else, so this generator rewrites the published schemas
into that subset without changing the contract the bridge validates at runtime:

- inline every `$ref`/`$defs` pair the compact publisher emits;
- drop keywords the DSH subset does not accept (`minimum`, `maximum`,
  `minLength`, `maxLength`, `minItems`, `maxItems`, `minProperties`);
- keep `description`/`title`/`default`/`examples` beside `oneOf`, which the
  subset allows there.

The result is written as JSON next to the DSH plugin so the host can register
every tool synchronously at activation, before any device or bridge process
exists.
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"

# Keywords the DSH ToolRuntime accepts; anything else is an author error there.
DSH_KEYWORDS = frozenset({
    "type", "oneOf", "properties", "required", "additionalProperties",
    "items", "enum", "const",
    "description", "title", "default", "examples",
})
# Constraint keywords the DSH subset refuses beside `oneOf`.
ONE_OF_SIBLING_KEYWORDS = frozenset({
    "properties", "required", "additionalProperties", "items", "enum", "const",
})


def inline_refs(node, definitions):
    """Expand `$$ref` against the companion `$$defs` table, recursively."""
    if isinstance(node, list):
        return [inline_refs(item, definitions) for item in node]
    if not isinstance(node, dict):
        return node
    target = node.get("$ref")
    if isinstance(target, str) and target.startswith("#/$defs/"):
        name = target[len("#/$defs/"):]
        if name not in definitions:
            raise SystemExit("unresolved $ref: " + target)
        merged = dict(definitions[name])
        merged.update({key: value for key, value in node.items() if key != "$ref"})
        return inline_refs(merged, definitions)
    return {key: inline_refs(value, definitions) for key, value in node.items()}


def project(node):
    """Keep only the DSH subset, preserving every constraint it can express."""
    if isinstance(node, list):
        return [project(item) for item in node]
    if not isinstance(node, dict):
        return node
    if "oneOf" in node:
        result = {"oneOf": [project(branch) for branch in node["oneOf"]]}
        for key in ("description", "title", "default", "examples"):
            if key in node:
                result[key] = node[key]
        # A sibling constraint keyword is an author error in DSH, and the
        # published form never combines one with oneOf on the same node.
        stray = ONE_OF_SIBLING_KEYWORDS.intersection(node)
        if stray:
            raise SystemExit("oneOf with sibling constraints: " + ", ".join(sorted(stray)))
        return result
    result = {}
    for key, value in node.items():
        if key not in DSH_KEYWORDS:
            continue
        if key == "properties" and isinstance(value, dict):
            result[key] = {name: project(child) for name, child in value.items()}
        elif key == "items":
            result[key] = project(value)
        else:
            result[key] = value
    return result


def build():
    sys.path.insert(0, str(SERVER))
    import iphone_use as bridge  # noqa: E402 - the bridge owns the contract

    tools = []
    for tool in bridge.TOOLS:
        schema = tool["inputSchema"]
        definitions = schema.get("$defs", {})
        bare = {key: value for key, value in schema.items() if key != "$defs"}
        projected = project(inline_refs(bare, definitions))
        # Top-level annotation, not part of the enforced schema.
        projected.pop("examples", None)
        if projected.get("type") != "object" or projected.get("additionalProperties") is not False:
            raise SystemExit(tool["name"] + ": a PUA tool schema must be a closed object")
        tools.append({
            "name": tool["name"],
            "title": tool.get("title", tool["name"]),
            "description": tool["description"],
            "readOnly": bool(tool.get("annotations", {}).get("readOnlyHint")),
            "appOnly": tool.get("_meta", {}).get("ui", {}).get("visibility") == ["app"],
            "parameters": projected,
        })
    return {"version": bridge.VERSION, "tools": tools}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "dsh" / "plugin" / "tools.generated.json"))
    parser.add_argument("--check", action="store_true", help="fail when the committed file is stale")
    args = parser.parse_args()
    rendered = json.dumps(build(), indent=2, ensure_ascii=False, sort_keys=False) + "\n"
    target = Path(args.output)
    if args.check:
        if not target.is_file() or target.read_text() != rendered:
            raise SystemExit("tools.generated.json is stale; run dsh/scripts/emit_tools.py")
        print("tools.generated.json matches server/iphone_use.py")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered)
    print(str(target))


if __name__ == "__main__":
    main()
