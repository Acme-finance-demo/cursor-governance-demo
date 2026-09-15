#!/usr/bin/env python3
"""snapshot.json のアドバイザリ URL を実際に叩いて、404 を代替先に差し替える。

Trivy の PrimaryURL は avd.aquasec.com を指すが、公表されたばかりの CVE は
あちらにページがまだ無く 404 になる。推測した URL をそのまま載せないために、
ビルドのたびにここで到達性を確かめる。

  1. PrimaryURL を GET する。200/3xx ならそのまま採用。
  2. 404 なら代替先（CVE は NVD、GHSA は GitHub Advisory Database）を試す。
  3. どちらも駄目なら url を空にする。レンダラはリンクを張らず素のテキストにする。

403 / 429 / 接続失敗はボット判定や一時的な失敗であって「無い」ではないので、
待って引き直す。それでも決まらないものは変更せず、報告だけする。
"""

import argparse
import json
import pathlib
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)
ATTEMPTS = 3
TIMEOUT = 25


def status(url):
    """到達コードを返す。判定不能は None。"""
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}
    )
    for attempt in range(ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return response.status
        except urllib.error.HTTPError as err:
            # 403/429 はボット判定。404 と混ぜない。
            if err.code in (403, 429):
                time.sleep(2 * (attempt + 1))
                continue
            return err.code
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(2 * (attempt + 1))
    return None


def fallbacks(advisory_id):
    ident = advisory_id.upper()
    if ident.startswith("CVE-"):
        return [f"https://nvd.nist.gov/vuln/detail/{ident}"]
    if ident.startswith("GHSA-"):
        return [f"https://github.com/advisories/{advisory_id}"]
    return []


def resolve(pair):
    """(advisory_id, url) -> (advisory_id, 採用する url, 説明)"""
    advisory_id, url = pair
    code = status(url)
    if code is not None and 200 <= code < 400:
        return advisory_id, url, f"ok {code}"
    if code is None:
        return advisory_id, url, "undecided, left as is"
    for candidate in fallbacks(advisory_id):
        alt = status(candidate)
        if alt is not None and 200 <= alt < 400:
            return advisory_id, candidate, f"{code} -> fallback {alt}"
    return advisory_id, "", f"{code}, no reachable page; link dropped"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True, type=pathlib.Path)
    parser.add_argument("--workers", type=int, default=10)
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text())
    # 同じ CVE が複数リポジトリに出るので、URL 単位で 1 回だけ叩く。
    pairs = sorted({(f["cve"], f["url"]) for f in snapshot["findings"] if f["url"]})
    print(f"checking {len(pairs)} advisory URLs")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(resolve, pairs))

    replacements = {}
    changed = []
    dropped = []
    undecided = []
    for advisory_id, url, note in results:
        original = dict(pairs)[advisory_id]
        if url != original:
            replacements[original] = url
            (dropped if url == "" else changed).append((advisory_id, note, url))
        if "undecided" in note:
            undecided.append((advisory_id, original))

    for finding in snapshot["findings"]:
        if finding["url"] in replacements:
            finding["url"] = replacements[finding["url"]]

    args.snapshot.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n")

    for advisory_id, note, url in sorted(changed):
        print(f"  {advisory_id}: {note} -> {url}")
    for advisory_id, note, _ in sorted(dropped):
        print(f"  {advisory_id}: {note}")
    for advisory_id, url in sorted(undecided):
        print(f"  {advisory_id}: could not be decided ({url})")
    print(
        f"{len(pairs) - len(changed) - len(dropped)} reachable as scanned, "
        f"{len(changed)} redirected to a fallback, {len(dropped)} dropped"
    )


if __name__ == "__main__":
    main()
