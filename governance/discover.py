#!/usr/bin/env python3
"""統制の対象リポジトリを毎回「発見」する。

登録制（対象を一覧に手で書く）だと、増えたリポジトリは誰かが登録するまで統制の外に
落ちる。だからこのスクリプトは run ごとに GitHub API でオーナーの持ち物を数え直し、
除外リストを引いた残り全部を対象にする。何もしないことがスコープ内に留まる。

入力:
  governance/discovery.json    owners（数え直す対象）と overrides（ref / 表示名）
  governance/exemptions.json   スコープから外す唯一の方法。理由つき
  GH_TOKEN                     GitHub API 用
  FILTER                       owner/repo のカンマ区切り。デモで絞るとき用（任意）

出力（GITHUB_OUTPUT）:
  matrix   [{name, slug, url, ref, key}]
  count    matrix の件数
  skipped  除外の内訳（1 行 1 件、Job Summary に出す用）
"""

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
ROOT = pathlib.Path(__file__).resolve().parent


def api_get(path: str):
    req = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "cursor-governance-demo-discovery",
            **({"Authorization": f"Bearer {os.environ['GH_TOKEN']}"} if os.environ.get("GH_TOKEN") else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def repos_of(owner: str):
    """オーナーの持ち物を全ページ取る。ユーザでも Organization でも同じ形で返る。"""
    out = []
    page = 1
    while True:
        try:
            batch = api_get(f"/users/{owner}/repos?per_page=100&type=owner&page={page}")
        except urllib.error.HTTPError as err:
            print(f"::error::could not list repositories for {owner}: {err}")
            sys.exit(1)
        if not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return out


def has_commits(slug: str) -> bool:
    try:
        return bool(api_get(f"/repos/{slug}/branches?per_page=1"))
    except urllib.error.HTTPError:
        # 読めないなら判断材料が無い。落とすより対象に入れて、clone の失敗として出す。
        return True


def main() -> None:
    config = json.loads((ROOT / "discovery.json").read_text())
    exemptions = {
        entry["repo"].lower(): entry
        for entry in json.loads((ROOT / "exemptions.json").read_text()).get("exemptions", [])
    }
    overrides = {key.lower(): value for key, value in (config.get("overrides") or {}).items()}
    wanted = {s.strip().lower() for s in (os.environ.get("FILTER") or "").split(",") if s.strip()}

    matrix, skipped = [], []
    for owner in config.get("owners") or []:
        for repo in repos_of(owner):
            slug = repo["full_name"]
            key = slug.lower()

            if key in exemptions:
                reason = exemptions[key].get("reason", "no reason recorded")
                skipped.append(f"{slug} — exempt: {reason}")
                continue
            if repo.get("archived"):
                skipped.append(f"{slug} — archived")
                continue
            # コミットが 1 つも無いリポジトリは clone できないので飛ばす。size は push 直後
            # だと 0 のまま返ってくる（非同期で集計される）ので、size だけで判定しないこと。
            if repo.get("size", 0) == 0 and not has_commits(slug):
                skipped.append(f"{slug} — no commits yet, nothing to scan")
                continue
            if wanted and key not in wanted:
                skipped.append(f"{slug} — not in this run's filter")
                continue

            override = overrides.get(key) or {}
            matrix.append(
                {
                    "name": override.get("name") or slug,
                    "slug": slug,
                    "url": repo["html_url"],
                    "ref": override.get("ref") or repo["default_branch"],
                    # artifact 名に使うので owner/repo の / を - に潰す
                    "key": slug.replace("/", "-"),
                }
            )

    matrix.sort(key=lambda entry: entry["slug"])

    print(f"discovered {len(matrix)} repositories under governance:")
    for entry in matrix:
        print(f"  in scope  {entry['slug']}@{entry['ref']}")
    for line in skipped:
        print(f"  out       {line}")

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as handle:
            handle.write(f"matrix={json.dumps(matrix, separators=(',', ':'))}\n")
            handle.write(f"count={len(matrix)}\n")
            handle.write("skipped<<EOF\n" + "\n".join(skipped) + "\nEOF\n")


if __name__ == "__main__":
    main()
