# 脆弱性オーケストレータ（使い方）

English: [USAGE.md](./USAGE.md)

このコントロールプレーンの概要とリポジトリの追加方法は [../README.ja.md](../README.ja.md) を参照。
構成とファイルの役割は [ARCHITECTURE.ja.md](./ARCHITECTURE.ja.md) を参照。
シーケンスは [SEQUENCE.ja.md](./SEQUENCE.ja.md) を参照。

GitLab CI / GitHub Actions の Trivy レポートを受け取り、Cursor SDK でトリアージ → 方針判定 → 修正 MR / PR まで進めるプロトタイプです。スキャンジョブ自体は CRITICAL が出ても失敗しません。修正は非同期です。

どちらのホスト上かは CI の環境変数（`GITLAB_CI` / `GITHUB_ACTIONS`）から自動判定するので、CLI は同じものが動きます。変わるのは repo URL、開始 ref、プロンプト内の MR / PR という呼び方だけです。

## 全体像

```
Trivy レポート
    → Agent.create（トリアージ、読み取り中心）
    → policy.ts（コードで判定。エージェントには任せない）
    → Agent.create（修正。cloud なら autoCreatePR）
    → Agent.create（影響分析。MR / PR / Issue 本文に英語で追記。コードは触らない）
    → CI 失敗時は Agent.resume（同じエージェントの続き）
```

SDK を呼ぶのはこのディレクトリの CLI だけです。Policy 判定とレポート整形は通常の TypeScript です。

## 必要要件

- Node.js 22.13 以上
- [Trivy](https://trivy.dev/)（ローカルスキャン用。macOS なら `brew install trivy`）
- [Cursor Dashboard](https://cursor.com/dashboard/api) の `CURSOR_API_KEY`（ユーザーキーまたはサービスアカウントキー）
- cloud ランタイムを使う場合: Cursor からこのリポジトリ（GitLab / GitHub）へアクセスできること

## インストール

```bash
cd cursor-sdk
npm ci
```

## どこで何を実行するか

ローカルは早く知るため、CI は正式なスキャン結果から MR / PR を出すため、です。手元の Trivy は CI と一致するとは限らないので、ローカルでは MR も PR も開きません。

| 場所 | やること | やらないこと |
| --- | --- | --- |
| ローカル | Trivy → トリアージ → Policy。ログと state ファイル | MR / PR を開く（`--skip-remediate`。`--runtime local`） |
| CI | 同じフローのあと、Policy を通ったものだけ cloud で修正 MR（GitLab）/ PR（GitHub）。続けて影響分析を英語でその本文に追記 | スキャン失敗でパイプラインを落とすこと |

オーケストレータは `cursor-sdk/` から実行し、監査対象のリポジトリは必ず `--cwd` で指定します。このリポジトリはコントロールプレーンであって、スキャンされる側ではありません。

### ローカルで実行するコマンド

`CURSOR_API_KEY` はシェルに export しておく（`~/.zshrc` など）。値はリポジトリに置かない。

対象リポジトリのチェックアウトをスキャンする:

```bash
cd cursor-sdk
npm run scan -- ~/src/petclinic
```

CRITICAL / HIGH / MEDIUM、Trivy ネイティブ JSON、検出しても exit 0。自動修正は Policy が CRITICAL だけ通す。レポートはカレントディレクトリの `trivy-report.json`。依存解決を省略するなら `npm run scan -- --skip-resolve ~/src/petclinic`。

スキャンからトリアージまで（推奨）。`--runtime local` と `--skip-remediate` が付くので、修正エージェントも PR も動きません:

```bash
cd cursor-sdk
npm run scan -- ~/src/petclinic
npx tsx src/cli.ts run \
  --report ./trivy-report.json \
  --cwd ~/src/petclinic \
  --runtime local \
  --skip-remediate
```

サンプル JSON で CLI だけ試す:

```bash
cd cursor-sdk
npx tsx src/cli.ts run \
  --report fixtures/trivy-report.sample.json \
  --cwd ~/src/petclinic \
  --runtime local \
  --skip-remediate
```

出力はターミナルの Policy 行と、対象リポジトリ側の `.cursor/vuln-orchestrator-state.json` です。対象の作業ツリーは変更しません。

### CI で実行されるコマンド

人が `--runtime cloud` を叩く必要はありません。このリポジトリの 2 つの GitHub ワークフローは同じコマンドを実行します。違うのはチェックアウトの配置だけです。

`repo-scan.yml`（アプリ側から呼ばれる）と `fleet-governance.yml`（このリポジトリのフリート実行）:

```bash
cd control/cursor-sdk
npm ci
npx tsx src/cli.ts run \
  --report "$GITHUB_WORKSPACE/trivy-report.json" \
  --cwd "$GITHUB_WORKSPACE/repo" \
  --runtime cloud
```

`control/` がこのリポジトリ、`repo/` が監査対象です。このディレクトリ名を `target` にしないこと。`--skip-dirs target` がスキャン対象ごと除外し、全リポジトリが「検出 0 件」になります。

GitLab CI では、アプリ側がコントロールプレーンをクローンします（アプリ側 `.gitlab-ci.yml` の `sdk-vuln-orchestrator`）:

```bash
git clone --depth 1 https://github.com/naoharu/cursor-governance-demo /tmp/control
cd /tmp/control/cursor-sdk
npm ci
npx tsx src/cli.ts run \
  --report "$CI_PROJECT_DIR/trivy-report.json" \
  --cwd "$CI_PROJECT_DIR" \
  --runtime cloud
```

`--skip-remediate` は付けません。`CURSOR_REPO_URL` と `CURSOR_STARTING_REF` は監査対象のリポジトリを指します（GitLab は `$CI_PROJECT_URL` / `$CI_COMMIT_SHA`、GitHub は呼び出し元リポジトリと `github.ref_name`。SHA ではなくブランチ名）。cloud かつ Policy 通過時だけ `autoCreatePR` で MR / PR が開き、続けて影響分析エージェントが Release Notes と対象リポジトリの利用箇所を読み、**英語で MR / PR 本文に追記**します（クローズ対象の Issue があればそこにも）。分析に失敗しても修正 MR / PR は残します。

オーケストレータが落ちてもマージは止まりません（GitLab は `allow_failure: true`、GitHub のフリートは `fail-fast: false` なので 1 リポジトリの失敗が他を止めません）。

セットアップ:

1. このリポジトリの **Settings → Secrets and variables → Actions** に `CURSOR_API_KEY` を追加（フリート実行の修正に必要）
2. `repo-scan.yml` を呼ぶアプリ側は `secrets: inherit` で自分のシークレットを渡す。無くてもスキャンと SARIF は動き、修正はフリート実行に任される
3. 監査対象リポジトリを [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) で Cursor に接続する。修正ブランチを push するのは Cloud Agent 自身なので GitHub App に書き込み権限が必要
4. GitLab 側はアプリリポジトリの **Settings → CI/CD → Variables** に `CURSOR_API_KEY` を追加し、旧 Cursor Automation の変数（`CURSOR_TRIVY_WEBHOOK_URL` / `CURSOR_TRIVY_API_KEY`）を無効化する（MR の二重防止）

一度ハマった注意点:

- 開始 ref はコミット SHA ではなくブランチ名。Cursor の ref 検証が push 直後の SHA を `Failed to verify existence of commit ...` で弾き、ブランチ名なら通る。冪等キーには SHA と対象リポジトリが入るので、同じコミットで同じリポジトリのエージェントが二重起動することはない
- `schedule` と `workflow_dispatch` は **デフォルトブランチ上のワークフローしか**動かない
- 1 リポジトリで最大 3 体（triage / fix / impact）の Cloud Agent を使う。フリートの matrix は `max-parallel: 1`。並列にするとプランの同時実行上限（`You've reached the limit for your current plan`）で落ちる。オーケストレータ側も待機リトライする
- 修正 PR の作成者は使うキーで変わる。`openAsCursorGithubApp` はサービスアカウントキーなら true（Cursor GitHub App 名義）、ユーザーキーなら false（自分の名義）が既定

### 修正 MR / PR の CI が落ちたあと（resume）

元の Trivy ジョブの失敗では resume しません。修正ブランチ側の build/test 失敗、またはエージェント run の失敗が対象です。使う `agentId` は CI の cloud エージェント（`bc-...`）です。

```bash
npx tsx src/cli.ts resume \
  --agent-id bc-... \
  --log /tmp/ci.log \
  --note "バージョンを上げたあとテストが落ちた"
```

`--agent-id` を省略すると `.cursor/vuln-orchestrator-state.json` の `remediationAgentId` を使います。ローカルのトリアージ state にはこの ID は入りません。

## CLI オプション

| オプション | コマンド | 説明 |
| --- | --- | --- |
| `--report <path>` | `run` | Trivy の JSON（`--format json`） |
| `--runtime local\|cloud` | `run` | 省略時は `VULN_RUNTIME`。未設定なら CI 上は `cloud`、それ以外は `local` |
| `--skip-remediate` | `run` | トリアージと Policy まで。修正エージェントは起動しない |
| `--cwd <path>` | 両方 | リポジトリルート上書き |
| `--agent-id <id>` | `resume` | 続きから動かすエージェント。省略時は state ファイル |
| `--log <path>` | `resume` | CI ログや失敗出力 |
| `--note <text>` | `resume` | オペレータからの短い指示 |

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `CURSOR_API_KEY` | はい | Cursor の API キー |
| `CURSOR_REPO_URL` | cloud 時 | clone 先。GitLab CI は `$CI_PROJECT_URL`、GitHub Actions は `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY`、CI 外は `origin` の remote |
| `CURSOR_STARTING_REF` | cloud 時 | 開始 ref。GitLab CI は `$CI_COMMIT_SHA`、GitHub Actions は `$GITHUB_REF_NAME`（push 直後の SHA を Cursor が検証できないためブランチ名） |
| `CURSOR_MODEL` | いいえ | デフォルト `composer-2.5` |
| `VULN_RUNTIME` | いいえ | `local` または `cloud` |
| `VULN_HOST` | いいえ | `github` / `gitlab`。自動判定の上書き。変わるのはプロンプト内の MR / PR の呼び方だけ |

## Policy（自動修正する条件）

判定は `src/policy.ts` にあります。エージェントの提案をそのまま採用しません。

自動修正 (`auto_remediate`) になるのは次をすべて満たす場合です。

- 重大度が `CRITICAL`（`AUTO_REMEDIATE_SEVERITIES`）
- バージョンを上げるだけで直せる
- 推奨バージョンがある
- メジャーバージョン上げではない（先頭の数字成分が上がらない）

それ以外は `comment_only` で、MR / PR 本文の TODO に回します。Spring Boot 本体の 3.x → 4.x などは人が判断します。

面接で拡張するなら、`AUTO_REMEDIATE_SEVERITIES` に `"HIGH"` を足すのが最短です。

## フリートモード（複数リポジトリ）

`repo-scan.yml` が守るのは、それを呼んだ 1 リポジトリだけです。`fleet-governance.yml` は同じフローをリポジトリ一覧に対して回します。単発の修正ではなく「統制」になるのはこの部分です。どちらも監査対象側にオーケストレータのコードを置きません。

| | 再利用可能ワークフロー | フリート |
| --- | --- | --- |
| ワークフロー | `.github/workflows/repo-scan.yml`（アプリ側が呼ぶ） | `.github/workflows/fleet-governance.yml` |
| トリガー | アプリ側の `push` / `pull_request` | `schedule`（毎日）/ `workflow_dispatch` / `governance/**` への `push` |
| 対象 | 呼び出し元のリポジトリ | `governance/fleet.json` の全エントリ |
| 出力 | アプリ側に修正 PR + SARIF | リポジトリごとに修正 PR + ここに横断サマリの Issue |

設定は `governance/fleet.json` です。`url` は必須、`ref` を省略するとそのリポジトリのデフォルトブランチ、`name` はレポートの表示名になります。

```json
{
  "repos": [
    { "name": "petclinic (Java / Maven)", "url": "https://github.com/acme/petclinic", "ref": "main" },
    { "name": "web (npm)", "url": "https://github.com/acme/web" }
  ]
}
```

フリート実行の流れ:

1. `plan` が `fleet.json` を読み、`ref` 未指定はデフォルトブランチを解決して matrix を出す
2. `scan` がリポジトリごとに走る（`fail-fast: false`、`max-parallel: 1`）。クローン → Trivy → トリアージ → policy → 修正 PR → 影響分析。各リポジトリの state ファイルを成果物として上げる
3. `report` が `governance/render-report.py` でサマリを組み立て、Job Summary **と** コントロールリポジトリの Issue に出す。リポジトリ別の検出数、policy が自動修正したもの、見送ったものとその理由、全修正 PR へのリンクが載る

対象が public なら追加トークンは不要です。Actions はクローンするだけで、修正 PR を push するのは Cursor の GitHub App です。private を対象にする場合は `repo` スコープの PAT をシークレットに入れ、クローンのステップで使います。

エコシステムはリポジトリごとに判定し（`cursor-sdk/src/ecosystem.ts`）、プロンプトが切り替わります（Maven / Gradle の managed version、npm の range と lockfile の使い分け、Go の `go get` + `go mod tidy`、Python の lockfile ツール）。policy は共通で変わりません。

把握しておくべき制約:

- `schedule` と `workflow_dispatch` は **デフォルトブランチ上のワークフローしか**動かしません
- matrix は直列（`max-parallel: 1`）です。1 リポジトリで最大 3 体の Cloud Agent を使うため、並列にするとプランの同時実行上限（`You've reached the limit for your current plan`）で落ちます。プランに余裕があれば増やしてかまいません
- 冪等キーは `<purpose>-<owner-repo>-<sha>` なので、同じコミットで 2 つのワークフローが走っても、リポジトリごとに同じエージェントが再利用され PR が二重になりません
- 「スキャンだけして修正はしない」も正式なモードです。`CURSOR_API_KEY` を設定しない、または `repo-scan.yml` に `remediate: false` を渡します

## CI ジョブ

| 場所 | ファイル | ジョブ |
| --- | --- | --- |
| ここ（フリート） | `.github/workflows/fleet-governance.yml` | `plan` → `scan`（matrix）→ `report` |
| ここ（再利用） | `.github/workflows/repo-scan.yml` | `scan`。アプリ側から呼ばれる |
| アプリ側（GitHub） | アプリ側の `.github/workflows/security.yml` | `repo-scan.yml` を `uses:` するジョブ 1 つ |
| アプリ側（GitLab） | アプリ側の `.gitlab-ci.yml` | `trivy-dependency-scan` + `sdk-vuln-orchestrator`（このリポジトリをクローンする） |

どの経路も上の「CI で実行されるコマンド」を実行します。スキャンジョブは CRITICAL でも失敗しません。

## 状態ファイル

パス: リポジトリルートの `.cursor/vuln-orchestrator-state.json`（gitignore 済み）

`host` / `triageAgentId` / `remediationAgentId` / `runId` / Policy 判定 / MR・PR の URL を保存します。resume と障害調査用です。cloud の run は Cursor 上で **Filter → Source → SDK** から見られます。

## 終了コード

| コード | 意味 |
| --- | --- |
| `0` | 正常終了（脆弱性ゼロで何もしない場合も含む） |
| `1` | 起動失敗（`CursorAgentError`: 認証・設定・ネットワーク）または CLI の使い方ミス |
| `2` | エージェントは起動したが run が失敗した |
| `64` | 引数不足（usage） |

## テスト（SDK は呼ばない）

```bash
cd cursor-sdk
npm test
npm run typecheck
```
