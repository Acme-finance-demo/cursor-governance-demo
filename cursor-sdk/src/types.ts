export type Runtime = "local" | "cloud";

/** どのフォージ上で動いているか。MR/PR の語彙と repo URL の解決に使う。 */
export type Host = "github" | "gitlab";

export type HostVocab = {
  /** "GitHub" / "GitLab" */
  host: string;
  /** "pull request" / "merge request" */
  pr: string;
  /** "PR" / "MR" */
  prShort: string;
  /** "GitHub Issue" / "GitLab Issue" */
  issue: string;
  /** "pull request comment" / "discussion comment" */
  comment: string;
};

export type HostContext = {
  host: Host;
  vocab: HostVocab;
  repoUrl: string;
  startingRef: string;
  /** CI が動いているリポジトリ（統制側）のコミット */
  sha?: string;
  /** 監査対象リポジトリの HEAD。冪等キーはこちらを使う */
  targetSha?: string;
  pipelineId?: string;
};

export type EcosystemId = "maven" | "gradle" | "npm" | "go" | "python" | "unknown";

export type EcosystemProfile = {
  id: EcosystemId;
  /** "Maven (Java)" のような表示名 */
  label: string;
  /** 検出したマニフェストの相対パス */
  manifests: string[];
  /** 修正エージェントに渡すエコシステム固有のルール */
  upgradeRules: string[];
  /** 影響分析エージェントに渡す再テストコマンド */
  testCommands: string[];
};

export type Finding = {
  id: string;
  severity: string;
  name: string;
  description: string;
  solution: string;
  package: string;
  version: string;
};

export type PackageGroup = {
  package: string;
  version: string;
  findings: Finding[];
};

export type TriageItem = {
  package: string;
  currentVersion: string;
  recommendedVersion: string | null;
  cves: string[];
  severity: string;
  isDirectDependency: boolean;
  isMajorBump: boolean;
  canFixByVersionBump: boolean;
  notes: string;
};

export type TriageReport = {
  summary: string;
  items: TriageItem[];
};

export type PolicyAction = "auto_remediate" | "comment_only";

/**
 * 修正段で実際に何が起きたか。policy の判断（action）とは別の軸。
 * already_open は「もう開いているので Agent を起こさなかった」= トークンを使っていない。
 * over_budget は「1 回あたりの上限に達したので次回に回した」。
 */
export type RemediationOutcome = "opened" | "already_open" | "over_budget" | "failed";

export type PolicyDecision = {
  action: PolicyAction;
  reason: string;
  item: TriageItem;
  outcome?: RemediationOutcome;
  /** outcome が opened / already_open のときのリクエスト URL */
  prUrl?: string;
};

export type PullRequestRecord = {
  /** どのパッケージグループに対する 1 本か */
  package: string;
  prUrl?: string;
  branch?: string;
  agentId: string;
  runId: string;
};

/** フリート横断レポート用の集計。 */
export type FindingSummary = {
  total: number;
  bySeverity: Record<string, number>;
  packageGroups: number;
};

export type OrchestratorState = {
  createdAt: string;
  runtime: Runtime;
  host?: Host;
  /** どのリポジトリを対象に走ったか。マルチリポジトリ実行のレポートで使う */
  repoUrl?: string;
  ecosystems?: EcosystemId[];
  findings?: FindingSummary;
  pipelineId?: string;
  sha?: string;
  /** 分析した対象リポジトリのコミット。PR がどの状態に対する提案かを固定する */
  targetSha?: string;
  /** この run で開いたリクエスト。パッケージグループごとに 1 本 */
  pullRequests?: PullRequestRecord[];
  triageAgentId?: string;
  triageRunId?: string;
  remediationAgentId?: string;
  remediationRunId?: string;
  impactAgentId?: string;
  impactRunId?: string;
  prUrl?: string;
  branch?: string;
  decisions: PolicyDecision[];
};
