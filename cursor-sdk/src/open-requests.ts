/**
 * 対象リポジトリで「もう開いている」修正リクエストを調べる。
 *
 * これを Agent に渡す前にやるのが肝。同じパッケージの PR / MR が既にあるなら、
 * もう一度 Agent を起こしても同じものが出てくるだけで、トークンだけが消える。
 *
 * こちら側でブランチ名を決められないので（SDK の CloudAgentOptions に指定する項目が
 * 無く、ブランチ名は Agent が自動で付ける）、独自マーカーではなく
 * 「Agent が作ったブランチの open なリクエストに、そのパッケージ名が載っているか」で
 * 判定する。Agent はタイトルにパッケージ名を書くので、これで足りる。
 */

import type { Host } from "./types.ts";

export type OpenRequest = {
  url: string;
  title: string;
  body: string;
  branch: string;
};

const PER_PAGE = 100;

/** github.com/owner/repo → owner/repo */
function slugOf(repoUrl: string): string {
  return repoUrl
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/");
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
    if (!res.ok) {
      console.error(`[orchestrator] could not list open requests (${res.status} ${res.statusText})`);
      return undefined;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(
      `[orchestrator] could not list open requests: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function listGitHub(repoUrl: string, env: Record<string, string | undefined>) {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const rows = await getJson<
    { html_url: string; title: string; body: string | null; head: { ref: string } }[]
  >(`https://api.github.com/repos/${slugOf(repoUrl)}/pulls?state=open&per_page=${PER_PAGE}`, {
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  return (rows ?? []).map((row) => ({
    url: row.html_url,
    title: row.title ?? "",
    body: row.body ?? "",
    branch: row.head?.ref ?? "",
  }));
}

async function listGitLab(repoUrl: string, env: Record<string, string | undefined>) {
  const token = env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN;
  const api = env.CI_API_V4_URL ?? "https://gitlab.com/api/v4";
  const project = encodeURIComponent(slugOf(repoUrl));
  const rows = await getJson<
    { web_url: string; title: string; description: string | null; source_branch: string }[]
  >(`${api}/projects/${project}/merge_requests?state=opened&per_page=${PER_PAGE}`, {
    ...(env.GITLAB_TOKEN ? { "PRIVATE-TOKEN": token ?? "" } : token ? { "JOB-TOKEN": token } : {}),
  });
  return (rows ?? []).map((row) => ({
    url: row.web_url,
    title: row.title ?? "",
    body: row.description ?? "",
    branch: row.source_branch ?? "",
  }));
}

export async function listAgentRequests(args: {
  host: Host;
  repoUrl: string;
  branchPrefix?: string;
  env?: Record<string, string | undefined>;
}): Promise<OpenRequest[]> {
  const env = args.env ?? process.env;
  const prefix = (args.branchPrefix ?? env.VULN_AGENT_BRANCH_PREFIX ?? "cursor/").toLowerCase();
  const all =
    args.host === "gitlab"
      ? await listGitLab(args.repoUrl, env)
      : await listGitHub(args.repoUrl, env);
  // 人間や Dependabot が開いたものを「Agent の作りかけ」と誤認しないよう、
  // Agent が作るブランチ名の接頭辞で絞る。
  return all.filter((row) => row.branch.toLowerCase().startsWith(prefix));
}

/**
 * `org.apache.logging.log4j:log4j-core` → `log4j-core`。
 * Agent はタイトルに短い名前を書くので、そこで照合する。
 */
export function shortPackageName(pkg: string): string {
  const tail = pkg.split(":").pop() ?? pkg;
  return (tail.split("/").pop() ?? tail).trim();
}

/** そのパッケージについて既に開いているリクエストを返す。無ければ undefined。 */
export function findOpenRequestFor(
  requests: OpenRequest[],
  pkg: string,
): OpenRequest | undefined {
  const candidates = [pkg, shortPackageName(pkg)]
    .map((name) => name.toLowerCase())
    .filter((name) => name.length >= 3);
  if (candidates.length === 0) return undefined;

  return requests.find((request) => {
    const haystack = `${request.title}\n${request.body}`.toLowerCase();
    return candidates.some((name) => {
      // 部分一致だと `crypto` が `crypto-js` に当たる。名前の前後が
      // 識別子として続いていないことを確認する。
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(name, from);
        if (at === -1) return false;
        const before = at === 0 ? "" : haystack[at - 1];
        const after = haystack[at + name.length] ?? "";
        const isEdge = (ch: string) => ch === "" || !/[a-z0-9._-]/.test(ch);
        if (isEdge(before) && isEdge(after)) return true;
        from = at + 1;
      }
    });
  });
}
