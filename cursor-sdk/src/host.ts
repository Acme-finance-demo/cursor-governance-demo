import { execFileSync } from "node:child_process";
import type { Host, HostContext, HostVocab } from "./types.ts";

/** GitLab は MR、GitHub は PR。プロンプトの語彙だけをここで切り替える。 */
const VOCAB: Record<Host, HostVocab> = {
  github: {
    host: "GitHub",
    pr: "pull request",
    prShort: "PR",
    issue: "GitHub Issue",
    comment: "pull request comment",
  },
  gitlab: {
    host: "GitLab",
    pr: "merge request",
    prShort: "MR",
    issue: "GitLab Issue",
    comment: "discussion comment",
  },
};

export function vocabFor(host: Host): HostVocab {
  return VOCAB[host];
}

export type Env = Record<string, string | undefined>;

/** CI の環境変数（または VULN_HOST）から判定する。ローカルでは undefined。 */
export function detectHost(env: Env): Host | undefined {
  const forced = env.VULN_HOST?.trim().toLowerCase();
  if (forced === "github" || forced === "gitlab") return forced;
  if (env.GITHUB_ACTIONS === "true" || env.GITHUB_REPOSITORY) return "github";
  if (env.GITLAB_CI === "true" || env.CI_PROJECT_URL) return "gitlab";
  return undefined;
}

export function hostFromUrl(url: string | undefined): Host | undefined {
  if (!url) return undefined;
  if (/github\./i.test(url)) return "github";
  if (/gitlab\./i.test(url)) return "gitlab";
  return undefined;
}

/** SSH 形式や末尾 .git を Cursor cloud が clone できる https 形式へ寄せる。 */
export function normalizeRepoUrl(url: string | undefined): string | undefined {
  const raw = url?.trim();
  if (!raw) return undefined;
  let normalized = raw;
  // ssh://git@host/owner/repo.git
  const ssh = normalized.match(/^ssh:\/\/(?:[^@/]+@)?(.+)$/);
  if (ssh) normalized = `https://${ssh[1]}`;
  // git@host:owner/repo.git
  const scp = normalized.match(/^[^@/:]+@([^:/]+):(.+)$/);
  if (scp) normalized = `https://${scp[1]}/${scp[2]}`;
  return normalized.replace(/\/+$/, "").replace(/\.git$/, "");
}

function gitRemoteOrigin(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function first(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export type ResolveHostArgs = {
  cwd: string;
  env?: Env;
  /** テスト用の差し替え。既定は origin の remote URL。 */
  gitRemote?: (cwd: string) => string | undefined;
};

/**
 * repo URL / 開始 ref / host を 1 か所で決める。
 * 優先順位: CURSOR_* の明示指定 → CI 変数 → git remote origin。
 */
export function resolveHostContext(args: ResolveHostArgs): HostContext {
  const env = args.env ?? process.env;
  const detected = detectHost(env);

  const ciRepoUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`
      : env.CI_PROJECT_URL;

  const remote = (args.gitRemote ?? gitRemoteOrigin)(args.cwd);

  const repoUrl =
    normalizeRepoUrl(first(env.CURSOR_REPO_URL, ciRepoUrl, remote)) ??
    "https://gitlab.com/naoharu1218/gitlab-sample";

  const host = detected ?? hostFromUrl(repoUrl) ?? "gitlab";

  return {
    host,
    vocab: VOCAB[host],
    repoUrl,
    // GitHub はブランチ名を先に見る。Cursor の ref 検証が push 直後の
    // コミット SHA を解決できないことがあるため（ブランチ名なら通る）。
    // GitLab は SHA 先で問題が出ていないので従来の順序を保つ。
    startingRef:
      first(
        env.CURSOR_STARTING_REF,
        ...(host === "github"
          ? [env.GITHUB_REF_NAME, env.GITHUB_SHA]
          : [env.CI_COMMIT_SHA, env.CI_COMMIT_REF_NAME]),
        env.GITHUB_SHA,
        env.CI_COMMIT_SHA,
        env.GITHUB_REF_NAME,
        env.CI_COMMIT_REF_NAME,
      ) ?? "main",
    sha: first(env.GITHUB_SHA, env.CI_COMMIT_SHA),
    pipelineId: first(env.GITHUB_RUN_ID, env.CI_PIPELINE_ID),
  };
}
