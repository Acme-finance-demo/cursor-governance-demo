#!/usr/bin/env python3
"""fleet governance の run の成果物を、レポート 1 枚ぶんの JSON に畳む。

入力（--artifacts のディレクトリ。`gh run download` がそのまま置く形）:
  trivy-report-<owner>-<repo>/trivy-report.json   検出の生データ
  scan-state-<owner>-<repo>/*.json                検査段のサマリ
  fleet-state-<owner>-<repo>/*.json               修正段の判断と PR
  open-prs.json                                   任意。ページを作った時点で開いている PR

出力:
  snapshot.json   render-vuln-page.py が読む唯一の入力

検査段と修正段を分けているのは fleet-governance.yml の都合（CRITICAL が出た
リポジトリだけ修正段に進む）で、レポートでは 1 リポジトリ 1 行に戻す。
"""

import argparse
import json
import pathlib
import re
from datetime import datetime, timezone

SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM")

# Trivy の Result.Type -> 表示名。提供元の公式表記に合わせる。
ECOSYSTEM_LABELS = {
    "pom": "Maven",
    "gradle": "Gradle",
    "npm": "npm",
    "yarn": "Yarn",
    "pnpm": "pnpm",
    "gomod": "Go",
    "pip": "pip",
    "poetry": "Poetry",
    "bundler": "Bundler",
    "cargo": "Cargo",
    "nuget": "NuGet",
    "composer": "Composer",
}


def ecosystem_label(kind):
    return ECOSYSTEM_LABELS.get(kind, kind)


def load_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as err:
        print(f"skipping {path}: {err}")
        return None


def states_from(root, prefix):
    """slug -> state。ファイル名ではなく state 内の fleetSlug を鍵にする。"""
    found = {}
    for directory in sorted(root.glob(f"{prefix}-*")):
        for path in sorted(directory.glob("*.json")):
            data = load_json(path)
            if data and data.get("fleetSlug"):
                found[data["fleetSlug"]] = data
    return found


def cvss_score(vuln):
    """ベンダごとに違う CVSS のうち、v3/v4 の最大値を採る。無ければ None。"""
    scores = []
    for entry in (vuln.get("CVSS") or {}).values():
        for key in ("V4Score", "V3Score", "V2Score"):
            if isinstance(entry, dict) and isinstance(entry.get(key), (int, float)):
                scores.append(float(entry[key]))
                break
    return max(scores) if scores else None


def findings_from_report(report, slug):
    """Trivy の Results を 1 件 1 行に潰す。件数は scan-state の total と一致する。"""
    rows = []
    for result in report.get("Results") or []:
        target = result.get("Target") or ""
        kind = result.get("Type") or ""
        for vuln in result.get("Vulnerabilities") or []:
            rows.append(
                {
                    "repo": slug,
                    "target": target,
                    "ecosystem": ecosystem_label(kind),
                    "package": vuln.get("PkgName") or "",
                    "installed": vuln.get("InstalledVersion") or "",
                    "fixed": vuln.get("FixedVersion") or "",
                    "cve": vuln.get("VulnerabilityID") or "",
                    "title": (vuln.get("Title") or "").strip(),
                    "severity": (vuln.get("Severity") or "").upper(),
                    "cvss": cvss_score(vuln),
                    "url": vuln.get("PrimaryURL") or "",
                    "published": (vuln.get("PublishedDate") or "")[:10],
                }
            )
    return rows


def decision_rows(state):
    """policy の判断を、パッケージ単位の一覧に落とす。"""
    rows = []
    for decision in state.get("decisions") or []:
        item = decision.get("item") or {}
        rows.append(
            {
                "action": decision.get("action") or "",
                "reason": decision.get("reason") or "",
                "outcome": decision.get("outcome") or "",
                "prUrl": decision.get("prUrl") or "",
                "package": item.get("package") or "",
                "currentVersion": item.get("currentVersion") or "",
                "recommendedVersion": item.get("recommendedVersion") or "",
                "severity": (item.get("severity") or "").upper(),
                "cves": item.get("cves") or [],
                "isDirectDependency": bool(item.get("isDirectDependency")),
                "isMajorBump": bool(item.get("isMajorBump")),
                "notes": item.get("notes") or "",
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--owner", default="Acme-finance-demo")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--run-url", default="")
    args = parser.parse_args()

    root = args.artifacts
    scans = states_from(root, "scan-state")
    remediated = states_from(root, "fleet-state")

    reports = {}
    scanned_at = None
    trivy_version = ""
    for directory in sorted(root.glob("trivy-report-*")):
        path = directory / "trivy-report.json"
        report = load_json(path) if path.exists() else None
        if not report:
            continue
        # ディレクトリ名は trivy-report-<owner>-<repo>。owner に - が入るので
        # 前から owner を剥がす（repo 名の - で割らない）。
        key = re.sub(rf"^trivy-report-{re.escape(args.owner)}-", "", directory.name)
        meta = report.get("Metadata") or {}
        repo_url = meta.get("RepoURL") or ""
        slug = f"{args.owner}/{key}"
        if repo_url:
            slug = repo_url.removesuffix(".git").split("github.com/")[-1]
        reports[slug] = report
        created = report.get("CreatedAt") or ""
        if created and (scanned_at is None or created < scanned_at):
            scanned_at = created
        trivy_version = (report.get("Trivy") or {}).get("Version") or trivy_version

    open_prs = []
    prs_path = root / "open-prs.json"
    if prs_path.exists():
        open_prs = load_json(prs_path) or []

    repos = []
    findings = []
    for slug in sorted(set(scans) | set(remediated) | set(reports)):
        scan = scans.get(slug) or {}
        fixed = remediated.get(slug) or {}
        merged = {**scan, **fixed}
        counts = (merged.get("findings") or {}).get("bySeverity") or {}
        report = reports.get(slug) or {}
        meta = report.get("Metadata") or {}
        rows = findings_from_report(report, slug)
        findings += rows
        # 生態系とパッケージ数は検出そのものから数える。state の値は使わない。
        ecosystems = sorted({row["ecosystem"] for row in rows if row["ecosystem"]})
        packages = len({(row["ecosystem"], row["package"]) for row in rows if row["package"]})

        repos.append(
            {
                "slug": slug,
                "name": merged.get("fleetName") or slug.split("/")[-1],
                "ref": merged.get("fleetRef") or meta.get("Branch") or "",
                "commit": (meta.get("RepoCommit") or "")[:7],
                "ecosystems": ecosystems,
                "total": int((merged.get("findings") or {}).get("total", 0)),
                "bySeverity": {sev: int(counts.get(sev, 0)) for sev in SEVERITIES},
                "packages": packages,
                "remediationRan": bool(fixed),
                "error": merged.get("error") or "",
                "decisions": decision_rows(merged),
            }
        )

    snapshot = {
        "owner": args.owner,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scannedAt": scanned_at or "",
        "scanner": f"Trivy {trivy_version}" if trivy_version else "Trivy",
        "runId": args.run_id,
        "runUrl": args.run_url,
        "repos": repos,
        "findings": findings,
        "openPullRequests": open_prs,
    }

    args.out.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n")
    total = sum(r["total"] for r in repos)
    critical = sum(r["bySeverity"]["CRITICAL"] for r in repos)
    print(
        f"{len(repos)} repositories, {total} findings ({critical} CRITICAL), "
        f"{len(findings)} rows, {len(open_prs)} open pull requests -> {args.out}"
    )


if __name__ == "__main__":
    main()
