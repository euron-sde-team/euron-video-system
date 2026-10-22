#!/usr/bin/env python3
"""Regenerate the Inputs/Outputs tables in every modules/*/README.md from
variables.tf and outputs.tf, keeping each README's hand-written summary
(the paragraph under the title). Run: python3 infra/terraform/gen-module-docs.py"""
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))


def blocks(path, kind):
    src = open(path).read()
    for m in re.finditer(kind + r' "([^"]+)" \{(.*?)\n\}', src, re.S):
        body = m.group(2)
        desc = re.search(r'description\s*=\s*"((?:[^"\\]|\\.)*)"', body)
        typ = re.search(r"\btype\s*=\s*(.+)", body)
        default = re.search(r"\bdefault\s*=\s*(.+)", body)
        yield (
            m.group(1),
            desc.group(1).replace('\\"', '"') if desc else "",
            typ.group(1).strip() if typ else "",
            default.group(1).strip() if default else None,
        )


def cell(text):
    return text.replace("|", "\\|")


for mod in sorted(os.listdir(os.path.join(ROOT, "modules"))):
    base = os.path.join(ROOT, "modules", mod)
    readme = os.path.join(base, "README.md")
    summary = open(readme).read().split("\n")[2] if os.path.exists(readme) else ""
    lines = [f"# `{mod}` module", "", summary, "", "## Inputs", "",
             "| Name | Description | Type | Default |", "|---|---|---|---|"]
    for name, desc, typ, default in blocks(os.path.join(base, "variables.tf"), "variable"):
        shown = "required" if default is None else f"`{cell(default)}`"
        lines.append(f"| `{name}` | {cell(desc)} | `{cell(typ)}` | {shown} |")
    lines += ["", "## Outputs", "", "| Name | Description |", "|---|---|"]
    for name, desc, _, _ in blocks(os.path.join(base, "outputs.tf"), "output"):
        lines.append(f"| `{name}` | {cell(desc)} |")
    open(readme, "w").write("\n".join(lines) + "\n")
print("module READMEs regenerated")
