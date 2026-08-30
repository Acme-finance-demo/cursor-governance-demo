# 何を作ったか

English: [ARCHITECTURE.md](./ARCHITECTURE.md)

使い方は [USAGE.ja.md](./USAGE.ja.md) を参照。
シーケンスは [SEQUENCE.ja.md](./SEQUENCE.ja.md) を参照。

## ひとことで

企業の SDLC 向けに、**CRITICAL 依存関係脆弱性をトリアージし、方針を通ったものだけ直す** Cursor SDK コントロールプレーンです。対象は複数リポジトリで、統制対象側は開かれる修正 PR 以外では変更されません。

スキャンでパイプラインは落としません。修正はあとからエージェントが MR（GitLab）または PR（GitHub）で追います。CLI は両ホスト共通で、どちらかは `host.ts` が判定します。

## Cursor SDK を使う場所

SDK を呼ぶのは `src/agent.ts` だけです。呼び出しは 4 種類です。

| 呼び出し | API | 役割 |
| --- | --- | --- |
| トリアージ | `Agent.create` + `send` | レポートと `pom.xml` を読み、JSON で分類する。ファイルは編集しない |
| 修正 | `Agent.create` + `send` | Policy を通ったパッケージだけバージョンを上げ、cloud なら MR / PR を開く |
| 影響分析 | `Agent.create` + `send` | コードは触らず、Release Notes と利用箇所から互換性・再テスト範囲を **英語で MR / PR / Issue 本文に追記** する |
| 続き | `Agent.resume` | 修正 MR / PR の CI 失敗などを、同じエージェントに渡して直す |

次は SDK ではありません。

- Trivy スキャン
- `policy.ts` の if/else
- GitLab CI / GitHub Actions の YAML
- Cursor Automations（`trigger-trivy-agent`）

## 処理の流れ

```
Trivy（ローカル scripts/trivy-scan.sh または CI trivy-dependency-scan）
        │  trivy-report.json
        ▼
cli.ts run
        │
        ├─ parse-report.ts     パッケージ単位にまとめる
        ├─ agent.ts            トリアージエージェント
        ├─ policy.ts           auto_remediate / comment_only
        ├─ agent.ts            修正エージェント（通ったものだけ）
        └─ agent.ts            影響分析エージェント（MR / PR / Issue 本文へ英語で追記）
                │
                ▼
        .cursor/vuln-orchestrator-state.json
                │
cli.ts resume → 同じ remediation agent
```

## ディレクトリ

すべてコントロールプレーン側にあります。監査対象のリポジトリはオーケストレータのコードを持たず、持つとしてもこちらを呼ぶワークフロー 1 つだけです。

```
cursor-governance-demo/              コントロールプレーン（このリポジトリ）
├── README.md / README.ja.md         何をするか、リポジトリの追加方法
├── .github/workflows/
│   ├── fleet-governance.yml         フリート実行: fleet.json を matrix で回して横断レポート
│   └── repo-scan.yml                アプリ側が呼ぶ再利用可能ワークフロー
├── governance/
│   ├── fleet.json                   継続的統制の対象リポジトリ
│   └── render-report.py             横断レポート（Job Summary + Issue）
└── cursor-sdk/
    ├── src/                         オーケストレータ
    ├── scripts/trivy-scan.sh        指定したチェックアウトに対するローカル Trivy
    ├── fixtures/                    デモ用サンプルレポート
    ├── USAGE.ja.md / USAGE.md
    └── ARCHITECTURE.ja.md / ARCHITECTURE.md

petclinic, web, api, …               監査対象のリポジトリ
└── .github/workflows/security.yml   ジョブ 1 つ: uses: …/repo-scan.yml@main
    （置かなくてもフリート実行が拾う）
```

## ファイルの役割

### オーケストレータ（`cursor-sdk/src/`）

| ファイル | 役割 |
| --- | --- |
| `cli.ts` | 入口。`run` / `resume`、引数と環境変数、リポジトリルートの特定 |
| `host.ts` | GitLab か GitHub かを CI 環境変数から判定し、clone URL / 開始 ref / MR・PR の呼び方を決める |
| `ecosystem.ts` | ツリー内のマニフェストから Maven / Gradle / npm / Go / Python を判定し、プロンプトに差し込む更新ルールとテストコマンドを供給する |
| `orchestrate.ts` | 手順の組み立て。レポート → トリアージ → Policy → 修正。エージェントを何台立てるかはここが決める |
| `agent.ts` | `@cursor/sdk` の薄い包み。`Agent.create` / `resume`、stream、`wait()`、起動失敗と run 失敗の切り分け |
| `policy.ts` | 自動修正してよいかの判定。重大度、直せるか、メジャーバージョンが上がるか。エージェントの提案は信用しすぎない |
| `parse-report.ts` | Trivy の JSON を `Finding` に直し、パッケージでグループ化する |
| `prompts.ts` | トリアージ・修正・影響分析・resume のプロンプト。エージェント出力から JSON を抜く |
| `state.ts` | `agentId` などを `.cursor/vuln-orchestrator-state.json` に保存・読み込み。resume 用 |
| `types.ts` | Finding / Triage / Policy / State の型 |
| `policy.test.ts` | パーサと Policy のユニットテスト。SDK は呼ばない |
| `host.test.ts` | ホスト判定と clone URL 正規化のユニットテスト。SDK は呼ばない |
| `ecosystem.test.ts` | 一時ディレクトリを使ったエコシステム判定のユニットテスト。SDK は呼ばない |

### スキャンとデモデータ

| ファイル | 役割 |
| --- | --- |
| `scripts/trivy-scan.sh` | ローカル Trivy。CI と同じく CRITICAL/HIGH/MEDIUM、Trivy JSON、検出しても exit 0。自動修正は Policy が CRITICAL のみ |
| `fixtures/trivy-report.sample.json` | 実スキャンなしで CLI を試すための 1 件サンプル（Tomcat / CVE-2026-43515） |

### パッケージ設定

| ファイル | 役割 |
| --- | --- |
| `package.json` | npm スクリプト（`scan` / `scan:run` / `run` / `resume` / `test`）と `@cursor/sdk` |
| `package-lock.json` | CI の `npm ci` 用ロック |
| `tsconfig.json` | `tsx` で `.ts` を直接実行するための TypeScript 設定 |

### リポジトリ側の変更

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/fleet-governance.yml` | フリートモード。`plan` → `governance/fleet.json` の matrix で `scan` → `report`。リポジトリごとに修正 PR、最後に横断 Issue |
| `.github/workflows/repo-scan.yml` | アプリ側が自分の push / PR で呼ぶ再利用可能（`workflow_call`）ワークフロー。呼び出し元をスキャンし、SARIF もそちらへ上げ、キーがあれば修正する |
| `governance/fleet.json` | 継続的統制の対象リポジトリ一覧 |
| `governance/render-report.py` | リポジトリ別の state から横断レポートを組み立てる |
| `.gitignore` | `node_modules/`、`trivy-report.json`、`trivy-results.sarif`、`states/`、`report.md` |

### 実行時にだけできるファイル（コミットしない）

| パス | 役割 |
| --- | --- |
| `trivy-report.json` | 直近の Trivy 出力。オーケストレータの入力 |
| `trivy-results.sarif` | GitHub のみ。Code scanning 用の同じ検出結果 |
| `.cursor/vuln-orchestrator-state.json` | 直近の `host` / `agentId` / run id / Policy 判定 / MR・PR の URL |

### 既存のまま（このプロトタイプの本体ではない）

| パス | 役割 |
| --- | --- |
| 監査対象側の `.cursor/automations/*` | Cursor Automation 用プロンプト。webhook で Cloud Agent を直接起動する別経路 |
| `.gitlab-ci.yml` の `trigger-trivy-agent` | その Automation を CI から叩くジョブ。SDK ジョブと両方有効だと MR が二重になる。GitHub には移植していない（Automation 側から直接トリガーできるため） |
| `.cursor/automations/tokyo-weather.md` | SDK / Automation の配線確認用サンプル。脆弱性フローとは無関係 |
| 監査対象リポジトリのソース | CI では `repo/` にクローンされる。トリアージ・修正・影響分析が対象とするワークスペース |

## Policy がコードにある理由

「全部エージェントに任せる」と、Spring Boot のメジャーバージョン上げまで自動になり得ます。企業では通らないので、自動にする条件は `policy.ts` に固定しています。

- `CRITICAL` だけ自動（`AUTO_REMEDIATE_SEVERITIES`）
- バージョンを上げるだけで直せる
- メジャーバージョン上げではない（先頭の数字が上がらない）

面接で足すなら、この Set に `"HIGH"` を足すのが最短です。

## ランタイム

| 場所 | デフォルト | 意味 |
| --- | --- | --- |
| 手元 | `local` | このマシンの作業ツリーを読む / 編集する |
| GitLab CI / GitHub Actions | `cloud` | Cursor の VM がリポジトリを clone する。修正時は `autoCreatePR` |

`--runtime` または `VULN_RUNTIME` で上書きできます。
