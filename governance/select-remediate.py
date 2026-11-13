#!/usr/bin/env python3
"""修正段に渡すリポジトリを、policy.ts の自動修正対象から選ぶ。

scan/*.json はスキャン段が残した検査サマリ。AUTO_REMEDIATE_SEVERITIES に入った
深刻度が 1 件も無いリポジトリは、Cloud Agent を起こさない。

入力:
  MATRIX                       plan 段の matrix JSON
  scan/*.json                  fleetSlug と findings.bySeverity
  cursor-sdk/src/policy.ts     AUTO_REMEDIATE_SEVERITIES

出力（GITHUB_OUTPUT）:
  matrix   修正段に渡す matrix
  count    その件数
"""

import glob
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def auto_remediate_severities():
    text = (ROOT / "cursor-sdk" / "src" / "policy.ts").read_text()
    match = re.search(
        r"AUTO_REMEDIATE_SEVERITIES\s*=\s*new Set\(\[([^\]]*)\]\)",
        text,
    )
    if not match:
        raise SystemExit("AUTO_REMEDIATE_SEVERITIES not found")
    return re.findall(r'"([A-Z]+)"', match.group(1))


def main():
    severities = auto_remediate_severities()
    actionable = []
    for path in sorted(glob.glob("scan/*.json")):
        state = json.loads(pathlib.Path(path).read_text())
        counts = (state.get("findings") or {}).get("bySeverity") or {}
        if any(int(counts.get(sev) or 0) > 0 for sev in severities):
            slug = state.get("fleetSlug")
            if slug:
                actionable.append(slug)
    print(
        "repositories with "
        + "/".join(severities)
        + " findings: "
        + json.dumps(actionable)
    )
    chosen = [
        row
        for row in json.loads(os.environ["MATRIX"])
        if row.get("slug") in set(actionable)
    ]
    output = os.environ.get("GITHUB_OUTPUT")
    lines = [
        "matrix=" + json.dumps(chosen, separators=(",", ":")),
        f"count={len(chosen)}",
    ]
    if output:
        with open(output, "a") as fh:
            fh.write("\n".join(lines) + "\n")
    else:
        print("\n".join(lines))
    for row in chosen:
        print(f"  will remediate {row['slug']}@{row.get('ref', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
