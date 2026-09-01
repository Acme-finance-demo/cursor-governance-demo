# Continuous vulnerability governance (control plane)

日本語: [README.ja.md](./README.ja.md)

This repository is the control plane. It scans a fleet of repositories for dependency
vulnerabilities, decides **in code** which findings may be fixed automatically, and lets a
Cursor cloud agent open the fix PR with an impact analysis attached.

Nothing in here is installed into the repositories it governs. An application repository
is discovered automatically, or calls one reusable workflow — never both a
copy of the orchestrator.

```
                      cursor-governance-demo (this repository)
                      ├── policy as code          cursor-sdk/src/policy.ts
                      ├── discovery             governance/discovery.json
                      ├── the only way out      governance/exemptions.json
                      └── the agents              cursor-sdk/src/
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   app repo (Java)           app repo (npm)            app repo (Go)
   fix PR + analysis         fix PR + analysis         fix PR + analysis
```

## Two ways a repository is covered

| | Fleet run | Reusable workflow |
| --- | --- | --- |
| Workflow | `.github/workflows/fleet-governance.yml` (here) | `.github/workflows/repo-scan.yml` (here), called by the app repo |
| Trigger | `schedule` (daily), `workflow_dispatch` | the app repo's own `push` / `pull_request` |
| Onboarding | nothing — the repository is discovered on the next run | add one job to the app repo |
| Story | continuous governance across every repository | shift-left on the change that introduces the risk |

Both run the same triage → policy → fix → impact flow, so a finding is treated the same
way whichever path reaches it first.

### Onboarding by fleet

```json
{
  "repos": [
    { "name": "petclinic (Java / Maven)", "url": "https://github.com/acme/petclinic", "ref": "main" },
    { "name": "web (npm)", "url": "https://github.com/acme/web" }
  ]
}
```

`url` is required. `ref` defaults to that repository's default branch. `name` is the label
in the report. Public repositories need no token: Actions only clones them, and the fix PR
is pushed by Cursor's GitHub App. For private targets, add a PAT with `repo` scope and use
it in the clone step.

### Onboarding by workflow

In the application repository:

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

`secrets: inherit` passes the caller's `CURSOR_API_KEY`. Without that secret the workflow
still scans and uploads SARIF, and remediation is left to the nightly fleet run — so an
application team can opt in to scanning without holding a key.

## What a run produces

- One fix PR per repository, listing the CVEs and packages it upgraded, with everything
  policy declined as a TODO list in the body
- An impact analysis appended to that PR's description: what changed, which call sites are
  affected, the re-test scope, breaking changes from the library's own release notes, and an
  overall 🟢 / 🟡 / 🔴 risk rating
- Trivy SARIF in the application repository's Security tab (reusable-workflow path)
- A roll-up report in the job summary and as an Issue here: per-repository findings, what
  was auto-fixed, what was deferred and why, and links to every fix PR

## Policy is code, not the agent's judgement

`cursor-sdk/src/policy.ts` decides. A package is auto-remediated only when all of these
hold:

- Severity is `CRITICAL` (`AUTO_REMEDIATE_SEVERITIES`)
- A version bump alone fixes it, and a recommended version exists
- It is not a major bump, and not a downgrade

Everything else is reported, never silently upgraded. Widening the rule is one line, and it
takes effect across the whole fleet on the next run — that is the point of a control plane.

## One request per package group, and only as many as you will read

A reviewer accepts or rejects one upgrade, so one pull request carries one package — every
installed version of it, since the same dependency is often present at several versions
across manifests, and splitting those apart puts concurrent agents on the same lockfile.
Batching every fix into a single request produced a 17,000-line lockfile diff on one
repository and mixed Go modules with an npm lockfile — two owners, two test suites, one
all-or-nothing merge.

Splitting alone would trade that for dozens of requests nobody reads, so two limits apply
before any agent starts:

- **A per-run budget.** At most `VULN_MAX_PULL_REQUESTS` requests per repository per run
  (`--max-prs`, default 5, `max_prs` on a manual workflow run). The rest are recorded as
  `over_budget` and picked up by a later run.
- **Nothing is proposed twice.** Open requests on branches under `cursor/` are listed first
  (`VULN_AGENT_BRANCH_PREFIX`), and a package group already covered by one is recorded as
  `already_open`. **No agent is started for it, so it costs nothing.**

The roll-up report shows all three outcomes, so a queue is visible rather than silent.

Groups do not depend on each other, so they do not run one at a time.
`VULN_AGENT_CONCURRENCY` (`--agent-concurrency`, default 3) sets how many agents run at
once inside a repository; total concurrency is that times the matrix's `max-parallel`.
Tokens track the work an agent does, not wall-clock time, so this shortens a run without
costing more. The per-plan ceiling on simultaneous cloud agents is not published, so the
default is deliberately low and overshoot is absorbed by the retry in `createWithRetry`
rather than by guessing the number.

## Setup

1. **Settings → Secrets and variables → Actions** here → add `CURSOR_API_KEY` (from the
   [Cursor dashboard](https://cursor.com/dashboard/api))
2. Connect the target repositories to Cursor at
   [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations). The cloud
   agent pushes the fix branch itself, so its GitHub App needs write access — `GITHUB_TOKEN`
   is not used for that
3. List the owners to enumerate in `governance/discovery.json`, or add the caller workflow to the app repositories

## Layout

| Path | Role |
| --- | --- |
| `.github/workflows/fleet-governance.yml` | Fleet run: discover, scan every repository in parallel, remediate the ones with CRITICAL findings, then the roll-up |
| `.github/workflows/repo-scan.yml` | Reusable workflow application repositories call |
| `governance/discover.py` | Enumerates the owners' repositories on every run |
| `governance/discovery.json` | Which owners to enumerate; per-repository ref and name overrides |
| `governance/exemptions.json` | The only way out of scope. Every entry carries a reason and a review date |
| `governance/render-report.py` | Per-repository state files → roll-up report |
| `cursor-sdk/` | The orchestrator: triage, policy, remediation, impact analysis |

Details: [cursor-sdk/USAGE.md](./cursor-sdk/USAGE.md) ·
[cursor-sdk/ARCHITECTURE.md](./cursor-sdk/ARCHITECTURE.md) ·
[cursor-sdk/SEQUENCE.md](./cursor-sdk/SEQUENCE.md)
