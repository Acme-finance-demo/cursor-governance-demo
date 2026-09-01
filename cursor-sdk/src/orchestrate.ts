import { readFile } from "node:fs/promises";
import { resumeAgent, runAgent } from "./agent.ts";
import { groupByPackage, parseFindings } from "./parse-report.ts";
import { findOpenRequestFor, listAgentRequests } from "./open-requests.ts";
import { decideAll } from "./policy.ts";
import {
  assertTriageReport,
  extractJson,
  impactPrompt,
  remediatePrompt,
  resumePrompt,
  triagePrompt,
} from "./prompts.ts";
import { defaultStatePath, writeState } from "./state.ts";
import type {
  EcosystemProfile,
  Host,
  HostVocab,
  OrchestratorState,
  PolicyDecision,
  PullRequestRecord,
  Runtime,
} from "./types.ts";

/**
 * 1 回の run で開くリクエストの上限。パッケージグループごとに 1 本にすると
 * レビューはしやすくなるが、何十本も開いたら誰も見ない。上限を超えた分は
 * over_budget として次の run に回す。
 */
const DEFAULT_MAX_PULL_REQUESTS = 5;

/** 1 リクエストの単位。同じパッケージの複数バージョンをまとめて 1 本にする。 */
type PackageBucket = { pkg: string; decisions: PolicyDecision[] };

/**
 * 同時に走らせる Cloud Agent の数（1 リポジトリ内）。
 *
 * グループ間に依存は無いので、直列にする理由は無い。トークンは Agent が働いた量に
 * 比例するので、並列度を上げても費用は変わらず、待ち時間だけ縮む。
 *
 * プランごとの同時実行上限は公開されていない（Pro が基準、Pro+ が 3 倍、Ultra が
 * 20 倍という比率だけが分かっている）。数を当てにいくのではなく、上限に当たったら
 * createWithRetry の待ちに吸収させる。2 本の同時実行は実測で通っている
 * （2026-09-01、slots-full にならず 41% 短縮）。
 */
const DEFAULT_AGENT_CONCURRENCY = 3;

export type RunArgs = {
  apiKey: string;
  reportPath: string;
  runtime: Runtime;
  cwd: string;
  host: Host;
  vocab: HostVocab;
  ecosystems: EcosystemProfile[];
  repoUrl: string;
  startingRef: string;
  pipelineId?: string;
  /** CI が動いているリポジトリ（統制側）のコミット */
  sha?: string;
  /** 監査対象リポジトリの HEAD */
  targetSha?: string;
  /** 1 回の run で開くリクエストの上限。既定 5 */
  maxPullRequests?: number;
  /** 同時に走らせる Cloud Agent 数（1 リポジトリ内）。既定 2 */
  agentConcurrency?: number;
  skipRemediate?: boolean;
};

/** org.apache.logging.log4j:log4j-core → org-apache-logging-log4j-log4j-core */
function packageSlug(pkg: string): string {
  return pkg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** github.com/owner/repo → owner-repo。冪等キーを対象リポジトリごとに分けるため。 */
function repoSlug(repoUrl: string): string {
  const parts = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/**
 * 二重起動を防ぐ鍵。**監査対象**のコミットで決める。
 *
 * 以前は CI が動いているリポジトリ（統制側）の SHA を使っていた。そのため対象が
 * 1 バイトも変わっていなくても統制側を触るたびに同じ内容の PR が増え、逆に対象の
 * コードが変わっても統制側が同じコミットなら古い Agent と古い分析が返ってきた。
 * どちらも同じ原因なので、対象の HEAD を鍵にする。
 */
function idempotencyKey(purpose: string, args: RunArgs): string | undefined {
  const base = args.targetSha ?? args.sha ?? args.pipelineId;
  return base ? `${purpose}-${repoSlug(args.repoUrl)}-${base}` : undefined;
}

export async function runOrchestrator(args: RunArgs): Promise<OrchestratorState> {
  const raw = JSON.parse(await readFile(args.reportPath, "utf8")) as unknown;
  const findings = parseFindings(raw);
  if (findings.length === 0) {
    console.error("[orchestrator] no vulnerabilities; stopping");
    const empty: OrchestratorState = {
      createdAt: new Date().toISOString(),
      runtime: args.runtime,
      host: args.host,
      repoUrl: args.repoUrl,
      ecosystems: args.ecosystems.map((e) => e.id),
      findings: { total: 0, bySeverity: {}, packageGroups: 0 },
      pipelineId: args.pipelineId,
      sha: args.sha,
    targetSha: args.targetSha,
      decisions: [],
    };
    await writeState(defaultStatePath(args.cwd), empty);
    return empty;
  }

  const groups = groupByPackage(findings);
  const bySeverity = new Map<string, number>();
  for (const finding of findings) {
    const severity = finding.severity.trim().toUpperCase() || "UNKNOWN";
    bySeverity.set(severity, (bySeverity.get(severity) ?? 0) + 1);
  }
  const findingSummary = {
    total: findings.length,
    bySeverity: Object.fromEntries(bySeverity),
    packageGroups: groups.length,
  };
  const severitySummary = [...bySeverity.entries()]
    .map(([severity, count]) => `${severity} ${count}`)
    .join(", ");
  console.error(
    `[orchestrator] ${findings.length} finding(s) in ${groups.length} package group(s) (${severitySummary})`,
  );

  const triage = await runAgent({
    apiKey: args.apiKey,
    name: "vuln-triage",
    prompt: triagePrompt(groups, args.vocab, args.ecosystems),
    runtime: args.runtime,
    cwd: args.cwd,
    repoUrl: args.repoUrl,
    startingRef: args.startingRef,
    autoCreatePR: false,
    idempotencyKey: idempotencyKey("vuln-triage", args),
  });

  const report = assertTriageReport(extractJson(triage.text));
  const decisions = decideAll(report.items);
  const auto = decisions.filter((d) => d.action === "auto_remediate");
  const deferred = decisions.filter((d) => d.action === "comment_only");

  console.error("[orchestrator] policy:");
  for (const decision of decisions) {
    console.error(
      `  ${decision.action.padEnd(15)} ${decision.item.package}  ${decision.reason}`,
    );
  }
  console.error(
    `[orchestrator] auto_remediate ${auto.length} of ${decisions.length} package group(s)`,
  );

  const state: OrchestratorState = {
    createdAt: new Date().toISOString(),
    runtime: args.runtime,
    host: args.host,
    repoUrl: args.repoUrl,
    ecosystems: args.ecosystems.map((e) => e.id),
    findings: findingSummary,
    pipelineId: args.pipelineId,
    sha: args.sha,
    targetSha: args.targetSha,
    triageAgentId: triage.agentId,
    triageRunId: triage.runId,
    decisions,
  };

  if (args.skipRemediate || auto.length === 0) {
    if (auto.length === 0) {
      console.error(
        `[orchestrator] nothing to auto-remediate (${deferred.length} comment-only); skipping fix agent`,
      );
    }
    await writeState(defaultStatePath(args.cwd), state);
    return state;
  }

  // Agent を起こす前に、もう開いているものを落とす。同じパッケージのリクエストが
  // 既にあるなら、もう一度走らせても同じ提案が出てくるだけで、トークンだけが減る。
  const openRequests = await listAgentRequests({ host: args.host, repoUrl: args.repoUrl });

  // 1 リクエスト = 1 パッケージ。同じ依存が別バージョンで複数箇所に入っていることが
  // あり（npm のマニフェストが複数ある場合など）、それを別グループとして扱うと、
  // 同じパッケージを直す Agent が同じ run の中で並列に立ち、lockfile を別々に
  // 再生成して同じ内容のリクエストが増える。同じ run 内なので already_open では防げない。
  const buckets: PackageBucket[] = [];
  const bucketOf = new Map<string, PackageBucket>();
  for (const decision of auto) {
    const pkg = decision.item.package;
    let bucket = bucketOf.get(pkg);
    if (!bucket) {
      bucket = { pkg, decisions: [] };
      bucketOf.set(pkg, bucket);
      buckets.push(bucket);
    }
    bucket.decisions.push(decision);
  }
  if (buckets.length !== auto.length) {
    console.error(
      `[orchestrator] ${auto.length} group(s) collapse into ${buckets.length} package(s) ` +
        `(the same dependency is installed at more than one version)`,
    );
  }

  const queue: PackageBucket[] = [];
  for (const bucket of buckets) {
    const existing = findOpenRequestFor(openRequests, bucket.pkg);
    if (existing) {
      for (const decision of bucket.decisions) {
        decision.outcome = "already_open";
        decision.prUrl = existing.url;
      }
      console.error(`  already_open    ${bucket.pkg}  ${existing.url} (no agent started)`);
      continue;
    }
    queue.push(bucket);
  }

  const budget = Math.max(1, args.maxPullRequests ?? DEFAULT_MAX_PULL_REQUESTS);
  const selected = queue.slice(0, budget);
  for (const bucket of queue.slice(budget)) {
    for (const decision of bucket.decisions) decision.outcome = "over_budget";
    console.error(
      `  over_budget     ${bucket.pkg}  deferred to a later run (budget ${budget})`,
    );
  }
  console.error(
    `[orchestrator] opening ${selected.length} ${args.vocab.pr}(s): ` +
      `${buckets.length - queue.length} already open, ${queue.length - selected.length} over budget`,
  );

  const requests: PullRequestRecord[] = [];
  state.pullRequests = requests;

  const remediateGroup = async (bucket: PackageBucket) => {
    const pkg = bucket.pkg;
    const elsewhere = selected
      .filter((other) => other !== bucket)
      .flatMap((other) => other.decisions);
    const scoped = [...bucket.decisions, ...deferred];

    let remediation;
    try {
      remediation = await runAgent({
        apiKey: args.apiKey,
        name: "vuln-remediate",
        prompt: remediatePrompt(scoped, args.vocab, args.ecosystems, elsewhere, args.startingRef),
        runtime: args.runtime,
        cwd: args.cwd,
        repoUrl: args.repoUrl,
        startingRef: args.startingRef,
        autoCreatePR: args.runtime === "cloud",
        idempotencyKey: idempotencyKey(`vuln-fix-${packageSlug(pkg)}`, args),
      });
    } catch (err) {
      for (const decision of bucket.decisions) decision.outcome = "failed";
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] fix agent failed for ${pkg}: ${message}`);
      await writeState(defaultStatePath(args.cwd), state);
      return;
    }

    for (const decision of bucket.decisions) {
      decision.outcome = "opened";
      decision.prUrl = remediation.prUrl;
    }
    requests.push({
      package: pkg,
      prUrl: remediation.prUrl,
      branch: remediation.branch,
      agentId: remediation.agentId,
      runId: remediation.runId,
    });
    // 単一リクエスト前提のフィールドは、1 本目を入れて後方互換を保つ
    state.remediationAgentId ??= remediation.agentId;
    state.remediationRunId ??= remediation.runId;
    state.prUrl ??= remediation.prUrl;
    state.branch ??= remediation.branch;

    console.error(
      `[orchestrator] ${pkg} → ${remediation.prUrl ?? "(no URL)"}  ` +
        `resume with: agentId=${remediation.agentId}`,
    );

    try {
      const impact = await runAgent({
        apiKey: args.apiKey,
        name: "vuln-impact",
        prompt: impactPrompt(
          scoped,
          args.vocab,
          args.ecosystems,
          remediation.prUrl,
          remediation.branch ?? args.startingRef,
        ),
        runtime: args.runtime,
        cwd: args.cwd,
        repoUrl: args.repoUrl,
        startingRef: remediation.branch ?? args.startingRef,
        autoCreatePR: false,
        prUrl: remediation.prUrl,
        idempotencyKey: idempotencyKey(`vuln-impact-${packageSlug(pkg)}`, args),
      });
      state.impactAgentId ??= impact.agentId;
      state.impactRunId ??= impact.runId;
      console.error(`[orchestrator] impact agentId=${impact.agentId} (${pkg})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[orchestrator] impact analysis failed for ${pkg} (the ${args.vocab.prShort} still stands): ${message}`,
      );
    }

    // 途中で落ちても、どこまで開いたかが残るように毎回書く
    await writeState(defaultStatePath(args.cwd), state);
  };

  const concurrency = Math.max(1, args.agentConcurrency ?? DEFAULT_AGENT_CONCURRENCY);
  console.error(
    `[orchestrator] running up to ${concurrency} agent(s) at a time over ${selected.length} group(s)`,
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= selected.length) return;
        await remediateGroup(selected[index]);
      }
    }),
  );
  // 並列で回すと完了順が変わるので、読み手のために並べ直す
  requests.sort((a, b) => a.package.localeCompare(b.package));

  await writeState(defaultStatePath(args.cwd), state);
  return state;
}

export async function resumeOrchestrator(args: {
  apiKey: string;
  agentId: string;
  cwd: string;
  vocab: HostVocab;
  logPath?: string;
  note?: string;
}): Promise<void> {
  const logText = args.logPath
    ? await readFile(args.logPath, "utf8")
    : "(no log file; follow the operator note)";
  const result = await resumeAgent({
    apiKey: args.apiKey,
    agentId: args.agentId,
    cwd: args.cwd,
    prompt: resumePrompt(logText, args.vocab, args.note),
  });
  console.error(`[orchestrator] resumed agentId=${result.agentId} runId=${result.runId}`);
  if (result.prUrl) console.error(`[orchestrator] ${args.vocab.prShort}: ${result.prUrl}`);
}
