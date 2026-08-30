# 継続的な脆弱性ガバナンス（コントロールプレーン）

English: [README.md](./README.md)

このリポジトリはコントロールプレーンです。複数リポジトリの依存関係脆弱性をスキャンし、
**どれを自動修正してよいかをコードで**判定し、Cursor の Cloud Agent が影響分析付きの修正 PR を開きます。

統制対象のリポジトリ側には何も入れません。アプリのリポジトリは `governance/fleet.json` に載るか、
再利用可能ワークフローを呼ぶかのどちらかで、オーケストレータのコピーを持つことはありません。

```
                      cursor-governance-demo（このリポジトリ）
                      ├── ポリシー（コード）      cursor-sdk/src/policy.ts
                      ├── 統制対象一覧            governance/fleet.json
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
| 追加方法 | `governance/fleet.json` に 1 エントリ足す | アプリ側にジョブ 1 つ足す |
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
    uses: naoharu/cursor-governance-demo/.github/workflows/repo-scan.yml@main
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

## セットアップ

1. このリポジトリの **Settings → Secrets and variables → Actions** に `CURSOR_API_KEY` を追加
   （[Cursor dashboard](https://cursor.com/dashboard/api) のキー）
2. 対象リポジトリを [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations)
   で Cursor に接続する。修正ブランチを push するのは Cloud Agent 自身なので、その GitHub App に
   書き込み権限が必要（`GITHUB_TOKEN` は使わない）
3. 対象リポジトリを `governance/fleet.json` に追加するか、呼び出し側ワークフローを置く

## 構成

| パス | 役割 |
| --- | --- |
| `.github/workflows/fleet-governance.yml` | フリート実行。`fleet.json` を matrix で回して横断レポート |
| `.github/workflows/repo-scan.yml` | アプリ側が呼ぶ再利用可能ワークフロー |
| `governance/fleet.json` | 統制対象のリポジトリ一覧 |
| `governance/render-report.py` | リポジトリ別 state → 横断レポート |
| `cursor-sdk/` | オーケストレータ本体（トリアージ・policy・修正・影響分析） |

詳細: [cursor-sdk/USAGE.ja.md](./cursor-sdk/USAGE.ja.md) ·
[cursor-sdk/ARCHITECTURE.ja.md](./cursor-sdk/ARCHITECTURE.ja.md) ·
[cursor-sdk/SEQUENCE.ja.md](./cursor-sdk/SEQUENCE.ja.md)
