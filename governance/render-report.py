#!/usr/bin/env python3
"""フリート横断の脆弱性ガバナンスレポートを組み立てる。

入力:
  states/*.json   リポジトリごとの orchestrator state（fleet-governance.yml が回収）
  MATRIX          plan ジョブが作った対象リポジトリ一覧（state が無い repo を落とさないため）
  RUN_URL         この run へのリンク

出力:
  report.md            Issue 本文
  report-title.txt     Issue タイトル
  $GITHUB_STEP_SUMMARY 同じ内容
"""

import json
import os
import pathlib
from datetime import datetime, timezone

STATE_DIR = pathlib.Path("states")
SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM")


def load_states():
    """slug -> state。ファイル名ではなく state 内の fleetSlug を鍵にする。"""
    states = {}
    if not STATE_DIR.exists():
        return states
    for path in sorted(STATE_DIR.rglob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as err:
            print(f"skipping {path}: {err}")
            continue
        slug = data.get("fleetSlug")
        if slug:
            states[slug] = data
    return states


def severity_counts(state):
    by_severity = (state.get("findings") or {}).get("bySeverity") or {}
    return {sev: int(by_severity.get(sev, 0)) for sev in SEVERITIES}


def decisions_by_action(state, action):
    return [d for d in (state.get("decisions") or []) if d.get("action") == action]


def decisions_by_outcome(state, outcome):
    """修正段で何が起きたか。policy の判断（action）とは別の軸で数える。"""
    return [d for d in (state.get("decisions") or []) if d.get("outcome") == outcome]


def package_label(decision):
    item = decision.get("item") or {}
    name = item.get("package", "?")
    current = item.get("currentVersion", "?")
    recommended = item.get("recommendedVersion") or "?"
    return f"`{name}` {current} → {recommended}"


def main() -> None:
    planned = json.loads(os.environ.get("MATRIX") or "[]")
    run_url = os.environ.get("RUN_URL", "")
    states = load_states()
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    rows = []
    totals = {sev: 0 for sev in SEVERITIES}
    total_findings = 0
    total_auto = 0
    total_deferred = 0
    prs = []
    deferred_detail = []
    failures = []
    total_already_open = 0
    total_over_budget = 0

    for entry in planned:
        slug = entry.get("slug")
        name = entry.get("name") or slug
        ref = entry.get("ref", "")
        state = states.get(slug)

        if state is None or state.get("error"):
            reason = (state or {}).get("error", "no result was collected")
            failures.append((name, slug, reason))
            rows.append(f"| [{name}](https://github.com/{slug}) | — | ⚠️ {reason} | — | — | — |")
            continue

        counts = severity_counts(state)
        for sev in SEVERITIES:
            totals[sev] += counts[sev]
        findings = (state.get("findings") or {}).get("total", 0)
        total_findings += findings

        auto = decisions_by_action(state, "auto_remediate")
        deferred = decisions_by_action(state, "comment_only")
        opened = decisions_by_outcome(state, "opened")
        already_open = decisions_by_outcome(state, "already_open")
        over_budget = decisions_by_outcome(state, "over_budget")
        total_auto += len(auto)
        total_deferred += len(deferred)
        total_already_open += len(already_open)
        total_over_budget += len(over_budget)

        ecosystems = ", ".join(state.get("ecosystems") or []) or "unknown"
        # 1 パッケージグループ = 1 リクエスト。古い state は prUrl 1 本しか持たない。
        requests = state.get("pullRequests") or []
        if not requests and state.get("prUrl"):
            requests = [{"package": "see the request body", "prUrl": state["prUrl"]}]
        for request in requests:
            if request.get("prUrl"):
                prs.append((name, request["prUrl"], request.get("package", "")))

        cell_parts = []
        if requests:
            cell_parts.append(
                " ".join(
                    f"[#{r['prUrl'].rstrip('/').split('/')[-1]}]({r['prUrl']})"
                    for r in requests
                    if r.get("prUrl")
                )
                or f"{len(requests)} opened, no URL"
            )
        if already_open:
            cell_parts.append(f"{len(already_open)} already open")
        if over_budget:
            cell_parts.append(f"{len(over_budget)} queued")
        pr_cell = " · ".join(cell_parts) or ("agent ran, no URL" if auto else "not needed")

        for decision in deferred:
            deferred_detail.append((name, decision))

        severity_cell = " / ".join(str(counts[sev]) for sev in SEVERITIES)
        status = "🟢 clean" if findings == 0 else ("🔴 fixing" if auto else "🟡 review")
        rows.append(
            f"| [{name}](https://github.com/{slug}) | `{ecosystems}` | {status} {severity_cell} "
            f"| {len(auto)} | {len(deferred)} | {pr_cell} |"
        )

    lines = [
        f"## 🛡️ Fleet vulnerability governance — {generated}",
        "",
        f"{len(planned)} repositories under continuous governance. "
        f"Scanned with Trivy, triaged by a Cursor cloud agent, and remediated only where policy allows.",
        "",
        "| Repository | Ecosystem | Findings C / H / M | Auto-fixed | Deferred | Fix PR |",
        "| --- | --- | --- | --- | --- | --- |",
        *rows,
        "",
        "### Fleet totals",
        "",
        f"- Findings: **{total_findings}** "
        f"(CRITICAL **{totals['CRITICAL']}**, HIGH {totals['HIGH']}, MEDIUM {totals['MEDIUM']})",
        f"- Package groups auto-remediated by policy: **{total_auto}**",
        f"- Package groups left for a human: **{total_deferred}**",
        f"- Fix pull requests opened: **{len(prs)}** (one per package group)",
        f"- Package groups skipped because a request was already open: **{total_already_open}** "
        f"— no agent was started for these",
        f"- Package groups queued for a later run (per-run limit): **{total_over_budget}**",
    ]
    if run_url:
        lines += [f"- Workflow run: {run_url}"]

    if prs:
        lines += ["", "### Fix pull requests", ""]
        for name, pr_url, package in prs:
            lines += [f"- **{name}** — `{package or 'see the request body'}` — {pr_url}"]

    if deferred_detail:
        lines += [
            "",
            "### Left for a human (policy did not auto-remediate)",
            "",
            "Policy lives in `cursor-sdk/src/policy.ts`: CRITICAL only, fixable by a version bump, "
            "and not a major bump. Everything else is reported, never silently upgraded.",
            "",
        ]
        for name, decision in deferred_detail[:20]:
            reason = decision.get("reason", "")
            lines += [f"- **{name}** — {package_label(decision)} — {reason}"]
        if len(deferred_detail) > 20:
            lines += [f"- …and {len(deferred_detail) - 20} more (see the per-repository artifacts)"]

    if failures:
        lines += ["", "### Repositories that need attention", ""]
        for name, slug, reason in failures:
            lines += [f"- **{name}** (`{slug}`) — {reason}"]

    body = "\n".join(lines) + "\n"
    pathlib.Path("report.md").write_text(body)
    pathlib.Path("report-title.txt").write_text(
        f"Fleet vulnerability governance — {generated} "
        f"({totals['CRITICAL']} CRITICAL, {len(prs)} fix PR)\n"
    )

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf8") as handle:
            handle.write(body)
    print(body)


if __name__ == "__main__":
    main()
