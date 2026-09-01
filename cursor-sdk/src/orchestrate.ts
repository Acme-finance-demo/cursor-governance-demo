import { readFile } from "node:fs/promises";
import { resumeAgent, runAgent } from "./agent.ts";
import { groupByPackage, parseFindings } from "./parse-report.ts";
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
  Runtime,
} from "./types.ts";

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
  skipRemediate?: boolean;
};

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

  const remediation = await runAgent({
    apiKey: args.apiKey,
    name: "vuln-remediate",
    prompt: remediatePrompt(decisions, args.vocab, args.ecosystems),
    runtime: args.runtime,
    cwd: args.cwd,
    repoUrl: args.repoUrl,
    startingRef: args.startingRef,
    autoCreatePR: args.runtime === "cloud",
    idempotencyKey: idempotencyKey("vuln-fix", args),
  });

  state.remediationAgentId = remediation.agentId;
  state.remediationRunId = remediation.runId;
  state.prUrl = remediation.prUrl;
  state.branch = remediation.branch;

  if (state.prUrl) console.error(`[orchestrator] ${args.vocab.prShort}: ${state.prUrl}`);
  console.error(`[orchestrator] resume with: agentId=${state.remediationAgentId}`);

  try {
    const impact = await runAgent({
      apiKey: args.apiKey,
      name: "vuln-impact",
      prompt: impactPrompt(decisions, args.vocab, args.ecosystems, state.prUrl),
      runtime: args.runtime,
      cwd: args.cwd,
      repoUrl: args.repoUrl,
      startingRef: state.branch ?? args.startingRef,
      autoCreatePR: false,
      prUrl: state.prUrl,
      idempotencyKey: idempotencyKey("vuln-impact", args),
    });
    state.impactAgentId = impact.agentId;
    state.impactRunId = impact.runId;
    console.error(`[orchestrator] impact agentId=${impact.agentId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] impact analysis failed (MR still stands): ${message}`);
  }

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
