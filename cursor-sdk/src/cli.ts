import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectEcosystems } from "./ecosystem.ts";
import { resolveHostContext, vocabFor } from "./host.ts";
import { resumeOrchestrator, runOrchestrator } from "./orchestrate.ts";
import { defaultStatePath, readState } from "./state.ts";
import type { Runtime } from "./types.ts";

function flag(name: string): boolean {
  return process.argv.includes(name);
}

/** 1 回の run で開くリクエストの上限。--max-prs > 環境変数 > 既定(5) */
function maxPullRequests(): number | undefined {
  const raw = opt("--max-prs") ?? process.env.VULN_MAX_PULL_REQUESTS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`[cli] ignoring an unusable --max-prs / VULN_MAX_PULL_REQUESTS: ${raw}`);
    return undefined;
  }
  return parsed;
}

function opt(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (
      existsSync(join(dir, "pom.xml")) ||
      existsSync(join(dir, ".gitlab-ci.yml")) ||
      existsSync(join(dir, ".github", "workflows"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function defaultRuntime(): Runtime {
  const fromEnv = process.env.VULN_RUNTIME;
  if (fromEnv === "local" || fromEnv === "cloud") return fromEnv;
  return process.env.CI ? "cloud" : "local";
}

function usage(): never {
  console.error(`Usage:
  npx tsx src/cli.ts run --report <trivy-report.json> [--runtime local|cloud] [--skip-remediate] [--cwd <repo>] [--max-prs <n>]
  npx tsx src/cli.ts resume [--agent-id <id>] [--log <ci-log.txt>] [--note <text>]

Env:
  CURSOR_API_KEY          required
  CURSOR_REPO_URL         cloud clone URL (GitHub Actions: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY,
                          GitLab CI: $CI_PROJECT_URL, otherwise the origin remote)
  CURSOR_STARTING_REF     cloud git ref (GitHub Actions: $GITHUB_SHA, GitLab CI: $CI_COMMIT_SHA)
  CURSOR_MODEL            default composer-2.5
  VULN_RUNTIME            local | cloud (CI defaults to cloud)
  VULN_HOST               github | gitlab (overrides autodetection; only changes PR/MR wording)
`);
  process.exit(64);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "run" && command !== "resume") usage();

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("CURSOR_API_KEY is required");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const cwd = resolve(opt("--cwd") ?? findRepoRoot(resolve(here, "../..")));
  const hostContext = resolveHostContext({ cwd });

  if (command === "run") {
    const reportPath = opt("--report");
    if (!reportPath) usage();
    const runtime = (opt("--runtime") as Runtime | undefined) ?? defaultRuntime();
    if (runtime !== "local" && runtime !== "cloud") usage();

    const ecosystems = detectEcosystems(cwd);
    console.error(
      `[orchestrator] host=${hostContext.host} repo=${hostContext.repoUrl} ref=${hostContext.startingRef}`,
    );
    console.error(
      `[orchestrator] ecosystems: ${ecosystems
        .map((e) => `${e.id}(${e.manifests.length} manifest(s))`)
        .join(", ")}`,
    );

    await runOrchestrator({
      apiKey,
      reportPath: resolve(reportPath),
      runtime,
      cwd,
      host: hostContext.host,
      vocab: hostContext.vocab,
      ecosystems,
      repoUrl: hostContext.repoUrl,
      startingRef: hostContext.startingRef,
      pipelineId: hostContext.pipelineId,
      sha: hostContext.sha,
      targetSha: hostContext.targetSha,
      maxPullRequests: maxPullRequests(),
      skipRemediate: flag("--skip-remediate"),
    });
    return;
  }

  const statePath = defaultStatePath(cwd);
  const saved = existsSync(statePath) ? await readState(statePath) : undefined;
  const agentId = opt("--agent-id") ?? saved?.remediationAgentId;
  if (!agentId) {
    console.error("resume needs --agent-id or a saved remediationAgentId in state");
    process.exit(1);
  }

  await resumeOrchestrator({
    apiKey,
    agentId,
    cwd,
    // ローカルから resume するときは、記録された host の語彙を優先する
    vocab: saved?.host ? vocabFor(saved.host) : hostContext.vocab,
    logPath: opt("--log"),
    note: opt("--note"),
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  const exitCode =
    err && typeof err === "object" && "exitCode" in err && typeof err.exitCode === "number"
      ? err.exitCode
      : 1;
  process.exit(exitCode);
});
