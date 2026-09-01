# 継続的な脆弱性ガバナンス（コントロールプレーン）

English: [README.md](./README.md)

このリポジトリはコントロールプレーンです。複数リポジトリの依存関係脆弱性をスキャンし
**どれを自動修正してよいかをコードで**判定し、Cursor の Cloud Agent が影響分析付きの修正 PR を開きます。

統制対象のリポジトリ側には何も入れません。アプリのリポジトリは自動で発見されるか、
再利用可能ワークフローを呼ぶかのどちらかで、オーケストレータのコピーを持つことはありません。

```
                      cursor-governance-demo（このリポジトリ）
                      ├── ポリシー（コード）      cursor-sdk/src/policy.ts
                      ├── 発見                  governance/discovery.json
                      ├── 除外（唯一の出口）    governance/exemptions.json
                      └── エージェント            cursor-sdk/src/
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   アプリ repo (Java)        アプリ repo (npm)         アプリ repo (Go)
   修正 PR + 影響分析        修正 PR + 影響分析        修正 PR + 影響分析
```

## 対象に含める 2 つの方法

| | フリート実行 | 再利用可能ワークフロー |
| --- | --- | --- |
| ワークフロー | `.github/workflows/fleet-governance.yml`（ここ） | `.github/workflows/repo-scan.yml`（ここ）をアプリ側が呼ぶ |
| トリガー | `schedule`（毎日）/ `workflow_dispatch` | アプリ側の `push` / `pull_request` |
| 追加方法 | 何もしない（次の run で発見される） | アプリ側にジョブ 1 つ足す |
| 位置づけ | 全リポジトリを常時見る継続的統制 | リスクを持ち込んだ変更の時点で止める shift-left |

どちらも同じ トリアージ → policy → 修正 → 影響分析 を通るので、どちらの経路で拾われても
同じ扱いになります。

### フリートに追加する

```json
{
  "repos": [
    { "name": "petclinic (Java / Maven)", "url": "https://github.com/acme/petclinic", "ref": "main" },
    { "name": "web (npm)", "url": "https://github.com/acme/web" }
  ]
}
```

`url` は必須、`ref` 省略時はそのリポジトリのデフォルトブランチ、`name` はレポートの表示名です。
public リポジトリならトークンは不要です（Actions はクローンするだけで、修正 PR を push するのは
Cursor の GitHub App）。private を対象にする場合は `repo` スコープの PAT をクローンのステップで使います。

### ワークフローから呼ぶ

アプリ側のリポジトリに置くもの:

```yaml
name: security

on:
  push:
    branches-ignore: ["cursor/**"]
  pull_request:

permissions:
  contents: read
  security-events: write

jobs:
  governance:
    uses: Acme-finance-demo/cursor-governance-demo/.github/workflows/repo-scan.yml@main
    with:
      remediate: ${{ github.event_name != 'pull_request' }}
    secrets: inherit
```

`secrets: inherit` で呼び出し側の `CURSOR_API_KEY` が渡ります。このシークレットが無くても
スキャンと SARIF アップロードは動き、修正は夜間のフリート実行に任されます。つまりアプリチームは
キーを持たずにスキャンだけ有効化することもできます。

## 実行結果として出るもの

- リポジトリごとの修正 PR。上げた CVE とパッケージを列挙し、policy が見送ったものは本文の TODO リストになる
- その PR 本文に追記される影響分析。何が変わったか、影響する利用箇所、再テスト範囲、
  ライブラリ自身の Release Notes に基づく破壊的変更、総合リスク 🟢 / 🟡 / 🔴
- アプリ側リポジトリの Security タブに Trivy の SARIF（再利用可能ワークフロー経路）
- Job Summary とこのリポジトリの Issue に出る横断レポート。リポジトリ別の検出数、
  自動修正したもの、見送ったものとその理由、全修正 PR へのリンク

## ポリシーはコードにある（エージェントの判断ではない）

判定は `cursor-sdk/src/policy.ts` です。次をすべて満たすときだけ自動修正します。

- 重大度が `CRITICAL`（`AUTO_REMEDIATE_SEVERITIES`）
- バージョンを上げるだけで直り、推奨バージョンがある
- メジャー上げでない、かつダウングレードでない

それ以外は報告するだけで、黙って上げることはありません。条件を広げるのは 1 行で、次回の実行から
フリート全体に効きます。これがコントロールプレーンを分けている理由です。

## 1 パッケージグループ 1 リクエスト、ただし読める本数だけ

レビュアーが受け入れ／却下するのはアップグレード 1 件なので、リクエスト 1 本にパッケージ
グループ 1 つを載せます。全部まとめていた頃は、あるリポジトリで lockfile の差分が 17,000 行になり、
Go modules と npm の lockfile が 1 本に同居していました。所有者もテストも別なのに、マージは
全部か無しかでした。

分けるだけでは誰も読まない本数になるので、**Agent を起こす前に** 2 つの制限をかけます。

- **1 回あたりの上限。** 1 リポジトリ 1 run あたり `VULN_MAX_PULL_REQUESTS` 本まで
  （`--max-prs`、既定 5、手動実行なら `max_prs`）。溢れた分は `over_budget` として記録し、
  次の run で拾います。
- **同じ提案を二度しない。** `cursor/` 配下のブランチで開いているリクエストを先に列挙し
  （`VULN_AGENT_BRANCH_PREFIX`）、そのパッケージが既に載っていれば `already_open` として
  記録します。**Agent を起動しないので、トークンを消費しません。**

横断レポートには 3 つの結果すべてが出るので、待ち行列が見えない形で溜まることはありません。

グループ間に依存は無いので、1 本ずつ順番に回す理由はありません。`VULN_AGENT_CONCURRENCY`
（`--agent-concurrency`、既定 3）で 1 リポジトリ内の同時 Agent 数を決めます。同時に走る
総数は、これに matrix の `max-parallel` を掛けた数です。**トークンは Agent が働いた量に
比例し、壁時計時間には比例しない**ので、並列度を上げても費用は増えず待ち時間だけ縮みます。
プランごとの同時実行上限は公開されていないため、既定値は控えめにし、超過は数を当てにいく
のではなく `createWithRetry` の待ちで吸収します。

## セットアップ

1. このリポジトリの **Settings → Secrets and variables → Actions** に `CURSOR_API_KEY` を追加
   （[Cursor dashboard](https://cursor.com/dashboard/api) のキー）
2. 対象リポジトリを [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations)
   で Cursor に接続する。修正ブランチを push するのは Cloud Agent 自身なので、その GitHub App に
   書き込み権限が必要（`GITHUB_TOKEN` は使わない）
3. 数え直す対象オーナーを `governance/discovery.json` に書くか、アプリ側に呼び出しワークフローを置く

## 構成

| パス | 役割 |
| --- | --- |
| `.github/workflows/fleet-governance.yml` | フリート実行。発見 → 全件を並列スキャン → CRITICAL のあるリポジトリだけ修正 → 横断レポート |
| `.github/workflows/repo-scan.yml` | アプリ側が呼ぶ再利用可能ワークフロー |
| `governance/discover.py` | run ごとにオーナーの持ちリポジトリを数え直す |
| `governance/discovery.json` | 数え直す対象オーナー。ref と表示名の上書き |
| `governance/exemptions.json` | スコープから外れる唯一の方法。理由と見直し日を必ず書く |
| `governance/render-report.py` | リポジトリ別 state → 横断レポート |
| `cursor-sdk/` | オーケストレータ本体（トリアージ・policy・修正・影響分析） |

詳細: [cursor-sdk/USAGE.ja.md](./cursor-sdk/USAGE.ja.md) ·
[cursor-sdk/ARCHITECTURE.ja.md](./cursor-sdk/ARCHITECTURE.ja.md) ·
[cursor-sdk/SEQUENCE.ja.md](./cursor-sdk/SEQUENCE.ja.md)
