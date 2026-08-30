# Vulnerability orchestrator (usage)

日本語: [USAGE.ja.md](./USAGE.ja.md)

What this control plane is and how a repository joins it: [../README.md](../README.md).
What we built and which file does what: [ARCHITECTURE.md](./ARCHITECTURE.md).
Sequences: [SEQUENCE.md](./SEQUENCE.md).

Takes a Trivy report from GitLab CI or GitHub Actions and runs triage → policy → a fix MR/PR via the Cursor SDK. The scan job itself does not fail on CRITICAL findings. Remediation is asynchronous.

The host is detected from CI environment variables (`GITLAB_CI` / `GITHUB_ACTIONS`), so the same CLI runs on both. Only the repo URL, the starting ref, and the MR/PR wording in the prompts change.

## Flow

```
Trivy report
    → Agent.create (triage, read-mostly)
    → policy.ts (decided in code, not by the agent)
    → Agent.create (remediate; autoCreatePR on cloud)
    → Agent.create (impact analysis; append English to the MR/PR/Issue body; no code edits)
    → on a later failure, Agent.resume (same agent)
```

The SDK is used only by the CLI in this directory. Policy and report parsing are plain TypeScript.

## Requirements

- Node.js 22.13+
- [Trivy](https://trivy.dev/) for local scans (`brew install trivy` on macOS)
- `CURSOR_API_KEY` from the [Cursor Dashboard](https://cursor.com/dashboard/api) (user key or service-account key)
- For the cloud runtime: Cursor must be able to access this repository (GitLab or GitHub)

## Install

```bash
cd cursor-sdk
npm ci
```

## What to run where

Local is for finding out early. CI is for opening an MR/PR from an official scan. A laptop Trivy report can disagree with CI, so local runs do not open MRs or PRs.

| Where | Do | Do not |
| --- | --- | --- |
| Local | Trivy → triage → policy. Logs and the state file | Open an MR/PR (`--skip-remediate`, `--runtime local`) |
| CI | The same flow, then a cloud fix MR (GitLab) / PR (GitHub) for whatever policy allows, then English impact analysis appended to its description | Fail the pipeline because the scan found CRITICAL |

Run the orchestrator from `cursor-sdk/`, and always point it at the repository you are auditing with `--cwd`. This repository is the control plane; it is not the thing being scanned.

### Commands to run locally

Export `CURSOR_API_KEY` in the shell (`~/.zshrc` or similar). Do not put the value in the repo.

Scan a checkout of the target repository:

```bash
cd cursor-sdk
npm run scan -- ~/src/petclinic
```

CRITICAL / HIGH / MEDIUM, native Trivy JSON, exit 0 even when findings exist. Auto-remediate stays CRITICAL-only in policy. The report is `trivy-report.json` in the current directory. Skip Maven resolution with `npm run scan -- --skip-resolve ~/src/petclinic`.

Scan through triage (recommended). `--runtime local` and `--skip-remediate` mean no fix agent and no PR:

```bash
cd cursor-sdk
npm run scan -- ~/src/petclinic
npx tsx src/cli.ts run \
  --report ./trivy-report.json \
  --cwd ~/src/petclinic \
  --runtime local \
  --skip-remediate
```

CLI only, with the sample JSON:

```bash
cd cursor-sdk
npx tsx src/cli.ts run \
  --report fixtures/trivy-report.sample.json \
  --cwd ~/src/petclinic \
  --runtime local \
  --skip-remediate
```

Output is the policy lines in the terminal plus `.cursor/vuln-orchestrator-state.json` inside the target repository. Its working tree is not modified.

### Commands CI runs

You do not need to pass `--runtime cloud` by hand. Both GitHub workflows in this repository run the same command; only the checkout layout differs.

`repo-scan.yml` (called by an application repository) and `fleet-governance.yml` (this repository's own fleet run):

```bash
cd control/cursor-sdk
npm ci
npx tsx src/cli.ts run \
  --report "$GITHUB_WORKSPACE/trivy-report.json" \
  --cwd "$GITHUB_WORKSPACE/repo" \
  --runtime cloud
```

`control/` is this repository, `repo/` is the repository being audited. Do not name that directory `target`: `--skip-dirs target` would then exclude the scan root and every scan comes back clean.

GitLab CI, where the app repository clones the control plane itself (`sdk-vuln-orchestrator` in the app repo's `.gitlab-ci.yml`):

```bash
git clone --depth 1 https://github.com/naoharu/cursor-governance-demo /tmp/control
cd /tmp/control/cursor-sdk
npm ci
npx tsx src/cli.ts run \
  --report "$CI_PROJECT_DIR/trivy-report.json" \
  --cwd "$CI_PROJECT_DIR" \
  --runtime cloud
```

There is no `--skip-remediate`. `CURSOR_REPO_URL` and `CURSOR_STARTING_REF` describe the repository being audited: `$CI_PROJECT_URL` / `$CI_COMMIT_SHA` on GitLab, and on GitHub the caller's repository with `github.ref_name` (a branch name, not a SHA). An MR (GitLab) or PR (GitHub) is opened with `autoCreatePR` only on cloud, and only for packages that pass policy. An impact agent then reads that library's release notes and the audited repository's call sites, and **appends English analysis to the MR/PR description** (and to a linked Issue if it closes one). If impact analysis fails, the fix MR/PR is still kept.

An orchestrator failure does not block merge: `allow_failure: true` on GitLab, and on GitHub the fleet matrix uses `fail-fast: false` so one repository cannot stop the rest.

Setup:

1. Add `CURSOR_API_KEY` to this repository (**Settings → Secrets and variables → Actions**) so the fleet run can remediate
2. Application repositories that call `repo-scan.yml` pass their own secret with `secrets: inherit`. Without it they still get scanning and SARIF, and remediation is left to the fleet run
3. Connect the audited repositories to Cursor at [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) — the cloud agent pushes the fix branch itself, so its GitHub App needs write access
4. On GitLab, add `CURSOR_API_KEY` under **Settings → CI/CD → Variables** in the app repository, and disable the older Cursor Automation variables (`CURSOR_TRIVY_WEBHOOK_URL` / `CURSOR_TRIVY_API_KEY`) so MRs are not duplicated

Notes that cost debugging time once:

- The starting ref is a branch name, not a commit SHA. Cursor's ref validation rejected a freshly pushed SHA with `Failed to verify existence of commit ...` while the branch name resolved fine. The idempotency key still contains the SHA and the target repository, so the same commit does not start two agents for the same repository
- `schedule` and `workflow_dispatch` only run workflows that exist on the **default branch**
- One repository takes up to three cloud agents (triage, fix, impact). The fleet matrix runs `max-parallel: 1` because a plan's concurrent-agent limit shows up as `You've reached the limit for your current plan`; the orchestrator also waits and retries on that error
- Who authors the fix PR depends on the key: `openAsCursorGithubApp` defaults to true for a service-account key (the PR shows up as the Cursor GitHub App) and false for a user key

### After the fix MR/PR's CI fails (resume)

Do not resume on a red Trivy job. Resume is for a failed build/test on the fix branch, or a failed agent run. The `agentId` is the cloud agent from CI (`bc-...`).

```bash
npx tsx src/cli.ts resume \
  --agent-id bc-... \
  --log /tmp/ci.log \
  --note "tests failed after the version bump"
```

If you omit `--agent-id`, the CLI reads `remediationAgentId` from `.cursor/vuln-orchestrator-state.json`. A local triage-only state file does not contain that id.

## CLI options

| Option | Command | Description |
| --- | --- | --- |
| `--report <path>` | `run` | Native Trivy JSON (`--format json`) |
| `--runtime local\|cloud` | `run` | Falls back to `VULN_RUNTIME`, then `cloud` in CI and `local` otherwise |
| `--skip-remediate` | `run` | Stop after triage and policy; do not start the fix agent |
| `--cwd <path>` | both | Override the repository root |
| `--agent-id <id>` | `resume` | Agent to continue. Defaults to the state file |
| `--log <path>` | `resume` | CI log or failure output |
| `--note <text>` | `resume` | Short operator instruction |

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `CURSOR_API_KEY` | yes | Cursor API key |
| `CURSOR_REPO_URL` | for cloud | Clone URL. GitLab CI: `$CI_PROJECT_URL`. GitHub Actions: `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY`. Off CI: the `origin` remote |
| `CURSOR_STARTING_REF` | for cloud | Starting ref. GitLab CI: `$CI_COMMIT_SHA`. GitHub Actions: `$GITHUB_REF_NAME` (branch name, because Cursor could not verify a freshly pushed SHA) |
| `CURSOR_MODEL` | no | Defaults to `composer-2.5` |
| `VULN_RUNTIME` | no | `local` or `cloud` |
| `VULN_HOST` | no | `github` or `gitlab`. Overrides autodetection; only changes the MR/PR wording in prompts |

## Policy (when a fix is automatic)

Decisions live in `src/policy.ts`. The orchestrator does not take the agent's recommendation at face value.

`auto_remediate` requires all of:

- Severity is `CRITICAL` (`AUTO_REMEDIATE_SEVERITIES`)
- A version bump alone is enough
- A recommended version exists
- It is not a major bump (first numeric component does not increase)

Everything else is `comment_only` and becomes a TODO in the MR/PR body. Spring Boot 3.x → 4.x stays a human decision.

The shortest live extension is adding `"HIGH"` to `AUTO_REMEDIATE_SEVERITIES`.

## Fleet mode (many repositories)

`repo-scan.yml` guards the one repository that calls it. `fleet-governance.yml` runs the same flow across a list of repositories, which is what makes it governance rather than a one-off fix. Neither puts orchestrator code into the repository being audited.

| | Reusable workflow | Fleet |
| --- | --- | --- |
| Workflow | `.github/workflows/repo-scan.yml`, called by the app repo | `.github/workflows/fleet-governance.yml` |
| Trigger | the app repo's `push` / `pull_request` | `schedule` (daily), `workflow_dispatch`, `push` on `governance/**` |
| Target | the calling repository | every entry in `governance/fleet.json` |
| Output | one fix PR + SARIF in the app repo | one fix PR per repository + a roll-up Issue here |

The fleet config is `governance/fleet.json`. `url` is required; `ref` defaults to that repository's default branch; `name` is the label used in the report.

```json
{
  "repos": [
    { "name": "petclinic (Java / Maven)", "url": "https://github.com/acme/petclinic", "ref": "main" },
    { "name": "web (npm)", "url": "https://github.com/acme/web" }
  ]
}
```

How a fleet run works:

1. `plan` reads `fleet.json`, resolves any missing `ref` to the repository's default branch, and emits a matrix
2. `scan` runs once per repository (`fail-fast: false`, `max-parallel: 1`): clone → Trivy → triage → policy → fix PR → impact analysis. Each repository's state file is uploaded as an artifact
3. `report` renders `governance/render-report.py` into the job summary **and** opens an Issue in the control repository: per-repo findings, what policy auto-fixed, what it deferred and why, and links to every fix PR

Public target repositories need no extra token: Actions only clones them, and the fix PR is pushed by Cursor's GitHub App. Add a PAT with `repo` scope as a secret and use it in the clone step for private targets.

Ecosystems are detected per repository (`cursor-sdk/src/ecosystem.ts`), and the prompts adapt: Maven/Gradle managed versions, npm lockfile-vs-range, `go get` + `go mod tidy`, or the Python lockfile tool. Policy is unchanged and shared by all of them.

Constraints worth knowing:

- `schedule` and `workflow_dispatch` only run workflows that exist on the **default branch**
- The matrix is serialized (`max-parallel: 1`) because each repository uses up to three cloud agents and a plan's concurrent-agent limit fails the run with `You've reached the limit for your current plan`. Raise it if the plan allows
- The idempotency key is `<purpose>-<owner-repo>-<sha>`, so two workflows triggered by the same commit reuse one agent per repository instead of opening duplicate PRs
- Scan only, no remediation, is a supported mode: leave `CURSOR_API_KEY` unset (or pass `remediate: false` to `repo-scan.yml`)

## CI jobs

| Where | File | Jobs |
| --- | --- | --- |
| Here (fleet) | `.github/workflows/fleet-governance.yml` | `plan` → `scan` (matrix) → `report` |
| Here (reusable) | `.github/workflows/repo-scan.yml` | `scan`, called by an app repository |
| App repo (GitHub) | its own `.github/workflows/security.yml` | one job that `uses:` `repo-scan.yml` |
| App repo (GitLab) | its own `.gitlab-ci.yml` | `trivy-dependency-scan` + `sdk-vuln-orchestrator`, which clones this repository |

Every path runs the command in “Commands CI runs” above. No scan job fails on CRITICAL findings.

## State file

Path: `.cursor/vuln-orchestrator-state.json` at the repo root (gitignored)

It stores `host` / `triageAgentId` / `remediationAgentId` / run IDs / policy decisions / MR-PR URL, for resume and debugging. Cloud runs show up in Cursor under **Filter → Source → SDK**.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (including "no vulnerabilities, nothing to do") |
| `1` | Startup failure (`CursorAgentError`: auth, config, network) or CLI misuse |
| `2` | The agent started, but the run failed |
| `64` | Missing arguments (usage) |

## Tests (no SDK calls)

```bash
cd cursor-sdk
npm test
npm run typecheck
```
