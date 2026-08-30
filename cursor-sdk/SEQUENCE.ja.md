# 脆弱性オーケストレータ シーケンス

English: [SEQUENCE.md](./SEQUENCE.md)

使い方: [USAGE.ja.md](./USAGE.ja.md) / 構成: [ARCHITECTURE.ja.md](./ARCHITECTURE.ja.md)

プロンプトはすべて `src/prompts.ts` から `agent.send()` に渡します。Cursor Automation に貼った文は、この SDK 経路では使われません。

## 登場するもの

| 略称 | 実体 | SDK か |
| --- | --- | --- |
| Dev | 手元の開発者 | いいえ |
| Trivy | `scripts/trivy-scan.sh` または CI の `trivy-dependency-scan` | いいえ |
| CLI | `cli.ts` → `orchestrate.ts` | 呼び出し元 |
| Policy | `policy.ts` | いいえ |
| Triage | Cursor Agent（`triagePrompt`） | はい |
| Fix | Cursor Agent（`remediatePrompt`） | はい |
| Impact | Cursor Agent（`impactPrompt`） | はい |
| フォージ | GitLab（リポジトリ / MR）または GitHub（リポジトリ / PR） | いいえ |
| Automation | Cursor Automation + `trigger-trivy-agent` | いいえ（別経路） |

---

## 1. ローカル（MR は開かない）

推奨コマンド: `cd cursor-sdk && npm run scan:run`  
（`--runtime local --skip-remediate`）

```mermaid
sequenceDiagram
    actor Dev
    participant Trivy as Trivy<br/>trivy-scan.sh
    participant CLI as CLI<br/>orchestrate.ts
    participant Parse as parse-report.ts
    participant Triage as Triage agent<br/>triagePrompt
    participant Policy as policy.ts
    participant State as vuln-orchestrator-state.json

    Dev->>Trivy: npm run scan
    Trivy->>Trivy: CRITICAL/HIGH/MEDIUM<br/>cursor-sdk は skip
    Trivy-->>Dev: trivy-report.json<br/>exit 0（検出しても落とさない）

    Dev->>CLI: run --runtime local --skip-remediate
    CLI->>Parse: レポートを Finding に正規化<br/>パッケージでグループ化
    Parse-->>CLI: PackageGroup[]

    alt 件数が 0
        CLI->>State: decisions: [] を保存
        CLI-->>Dev: 何もしないで終了
    else 1件以上
        CLI->>Triage: Agent.create(local) + send(triagePrompt)
        Note over Triage: pom.xml を読む<br/>編集・commit・MR はしない
        Triage-->>CLI: JSON（推奨バージョン, メジャーか, バージョン上げだけで直せるか）

        CLI->>Policy: decideAll(items)
        Policy-->>CLI: auto_remediate / comment_only

        Note over CLI: --skip-remediate なので<br/>Fix agent は起動しない
        CLI->>State: triageAgentId と decisions を保存
        CLI-->>Dev: ターミナルに Policy 行
    end
```

このあと MR は開きません。`remediationAgentId` も書きません。

---

## 2. CI（Policy を通ったものだけ MR / PR）

人が `--runtime cloud` を叩く必要はありません。同じフローに入口が 3 つあります（アプリ側が呼ぶ `repo-scan.yml`、`fleet-governance.yml` の `scan` matrix ジョブ、アプリ側 `.gitlab-ci.yml` の `sdk-vuln-orchestrator`）。`host.ts` が clone URL・開始 ref・MR / PR の呼び方を差し替え、`ecosystem.ts` が Maven / Gradle / npm / Go / Python の更新ルールを差し替えます。

```mermaid
sequenceDiagram
    actor Dev
    participant GL as CI<br/>（コントロールプレーン）
    participant Scan as trivy-dependency-scan
    participant CLI as CLI<br/>orchestrate.ts
    participant Triage as Triage agent<br/>triagePrompt
    participant Policy as policy.ts
    participant Fix as Fix agent<br/>remediatePrompt
    participant Impact as Impact agent<br/>impactPrompt
    participant Cursor as Cursor cloud VM
    participant Forge as GitLab MR /<br/>GitHub PR

    Dev->>GL: git push
    GL->>Scan: CRITICAL/HIGH/MEDIUM（ジョブは落とさない）
    Scan-->>GL: trivy-report.json

    GL->>CLI: tsx cli.ts run --runtime cloud<br/>（--skip-remediate なし）

    CLI->>Triage: Agent.create(cloud, autoCreatePR=false)<br/>send(triagePrompt)
    Note over Triage: プロンプトは prompts.ts<br/>Automation の文は使わない
    Triage->>Cursor: リポジトリを clone して pom.xml を読む
    Cursor-->>Triage: 作業ツリー
    Triage-->>CLI: JSON

    CLI->>Policy: CRITICAL か / バージョン上げだけで直せるか / メジャーではないか
    Policy-->>CLI: decisions[]

    alt auto_remediate が 0件
        CLI-->>GL: Fix を起動せず終了（MR / PR なし）
    else 1件以上
        CLI->>Fix: Agent.create(cloud, autoCreatePR=true)<br/>send(remediatePrompt)
        Note over Fix: AUTO だけバージョンを上げる<br/>comment_only は本文の TODO
        Fix->>Cursor: clone → pom を最小変更 → commit
        Cursor->>Forge: ブランチ push + MR / PR 作成
        Forge-->>Fix: MR / PR の URL
        Fix-->>CLI: prUrl, agentId (bc-...)
        CLI->>Impact: Agent.create(cloud, autoCreatePR=false)<br/>send(impactPrompt)
        Note over Impact: コードは編集しない<br/>Release Notes と利用箇所を見る
        Impact->>Forge: MR / PR / Issue 本文に英語で追記
        CLI-->>GL: state を artifact に保存
    end
```

Policy の中身は次のすべてを満たすときだけ `auto_remediate` です。

1. 重大度が CRITICAL
2. バージョンを上げるだけで直せる（`recommendedVersion` あり）
3. メジャーバージョン上げではない（先頭の数字が上がらない）

MR / PR 本文は TypeScript が書いていません。`remediatePrompt` を読んだ Fix agent が書きます。影響分析は `impactPrompt` が **英語で MR / PR / Issue 本文に追記** します（コメントではない）。

---

## 3. 修正 MR / PR の CI が落ちたあと（resume）

元の Trivy ジョブが赤でも resume しません。対象は修正ブランチの build/test 失敗か、エージェント run の失敗です。

```mermaid
sequenceDiagram
    actor Op as オペレータ / 後続ジョブ
    participant CLI as CLI<br/>resume
    participant Fix as 同じ Fix agent<br/>Agent.resume
    participant Forge as 修正 MR / PR

    Op->>CLI: resume --agent-id bc-... --log ci.log
    CLI->>Fix: Agent.resume(bc-...)<br/>send(resumePrompt)
    Note over Fix: 新しい agent は作らない<br/>prompts.ts の resumePrompt
    Fix->>Forge: 追加 commit（必要なら）
    Fix-->>CLI: runId / prUrl
```

ローカルのトリアージだけ回した state には `remediationAgentId` が無いので、この経路には使えません。

---

## 4. 使っていない経路（Cursor Automation、GitLab のみ）

SDK ジョブとは別物です。`CURSOR_TRIVY_WEBHOOK_URL` が残っていると、こちらも動いて MR が二重になります。GitHub Actions には移植していません。この webhook ジョブは GitLab に Automation 向けの「CI 完了」トリガーが無いから存在するものです。

```mermaid
sequenceDiagram
    participant GL as GitLab CI
    participant Hook as trigger-trivy-agent
    participant Auto as Cursor Automation
    participant Agent as Cloud Agent
    participant GitLab as GitLab MR

    GL->>Hook: Trivy 成果物
    Hook->>Auto: POST webhook + レポート JSON
    Note over Auto: ダッシュボードに貼った<br/>trivy-remediation.md
    Auto->>Agent: そのプロンプトで起動
    Agent->>GitLab: 依存のバージョン上げ + MR

    Note over GL,GitLab: sdk-vuln-orchestrator はこれを呼ばない
```

| 経路 | プロンプト | MR を開くか |
| --- | --- | --- |
| ローカル `scan:run` | `triagePrompt` のみ | 開かない |
| CI `sdk-vuln-orchestrator`（GitLab CI / GitHub Actions） | `triagePrompt` → 通れば `remediatePrompt` → `impactPrompt` | Policy 通過時だけ（影響分析は本文追記） |
| CI `trigger-trivy-agent` | Automation の markdown | Automation 側の設定次第 |

---

## プロンプトが渡る位置

```mermaid
flowchart LR
    subgraph code [cursor-sdk/src]
        P[prompts.ts]
        O[orchestrate.ts]
        A[agent.ts]
    end

    P -->|triagePrompt| O
    P -->|remediatePrompt| O
    P -->|impactPrompt| O
    P -->|resumePrompt| O
    O -->|agent.send prompt| A
    A -->|Agent.create / resume| SDK["@cursor/sdk"]
    SDK --> Local[local: このマシンの cwd]
    SDK --> Cloud[cloud: Cursor VM + 任意で autoCreatePR]
```
