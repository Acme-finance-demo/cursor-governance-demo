import { Agent, CursorAgentError, type SDKAgent } from "@cursor/sdk";
import type { Runtime } from "./types.ts";

export type AgentRunOptions = {
  apiKey: string;
  name: string;
  prompt: string;
  runtime: Runtime;
  cwd: string;
  repoUrl: string;
  startingRef: string;
  autoCreatePR: boolean;
  prUrl?: string;
  idempotencyKey?: string;
};

export type AgentRunOutcome = {
  agentId: string;
  runId: string;
  text: string;
  prUrl?: string;
  branch?: string;
};

/** 同時実行 Cloud Agent 数の上限。プラン依存で、待てば解消する。 */
const AGENT_SLOTS_FULL = /reached the limit|more cloud agents/i;
// 最初の 1 段が短いのは、埋めているのが自分のプールである場合が多いため
// （すぐ隣の Agent が終われば空く）。それでも空かないなら他の利用者と競合している。
const RETRY_DELAYS_MS = [15_000, 60_000, 120_000, 180_000];

/**
 * ストリームが先に解放されると wait() が status=error で返る。Agent 自体は
 * クラウドで動き続けて完走するので、これは run の失敗ではない。
 */
const STREAM_GONE = /stream is no longer available|stream (?:closed|ended|unavailable)/i;
const AGENT_API = "https://api.cursor.com/v0";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 30 * 60_000;
const NOT_TERMINAL = new Set(["RUNNING", "CREATING", "PENDING", "QUEUED"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Agent が既存のブランチ・PR を再利用したときは、作成者ではないので target に
 * branchName / prUrl が入らない。その場合でも Agent は自分の報告文に PR の URL を
 * 書くので、そこから拾う。構造化された値があればそちらを優先する。
 */
const PR_URL = /https:\/\/[^\s)\]]+?\/(?:pull\/\d+|-\/merge_requests\/\d+)/;

const prUrlIn = (text: string) => text.match(PR_URL)?.[0];

type CloudAgentSnapshot = {
  status?: string;
  target?: { prUrl?: string; branchName?: string };
};

type CloudConversation = {
  messages?: { type?: string; text?: string }[];
};

async function agentApi<T>(apiKey: string, path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${AGENT_API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * stream / wait を失ったあとの回収。Agent の終了まで待ってから、会話履歴から本文を、
 * Agent の target から作られたブランチと PR を取る。triage の出力は次段の入力なので、
 * ここを諦めるとフロー全体が止まる。
 */
async function recoverFinishedRun(apiKey: string, agentId: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let snapshot = await agentApi<CloudAgentSnapshot>(apiKey, `/agents/${agentId}`);
  while (
    Date.now() < deadline &&
    NOT_TERMINAL.has((snapshot?.status ?? "RUNNING").toUpperCase())
  ) {
    await sleep(POLL_INTERVAL_MS);
    snapshot = await agentApi<CloudAgentSnapshot>(apiKey, `/agents/${agentId}`);
  }
  if ((snapshot?.status ?? "").toUpperCase() !== "FINISHED") {
    return undefined;
  }

  const conversation = await agentApi<CloudConversation>(
    apiKey,
    `/agents/${agentId}/conversation`,
  );
  const text = (conversation?.messages ?? [])
    .filter((entry) => entry.type === "assistant_message" && entry.text)
    .map((entry) => entry.text as string)
    .join("\n");

  return { text, prUrl: snapshot?.target?.prUrl, branch: snapshot?.target?.branchName };
}

async function createWithRetry(opts: AgentRunOptions): Promise<SDKAgent> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await Agent.create(createOptions(opts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        !(err instanceof CursorAgentError) ||
        !AGENT_SLOTS_FULL.test(message)
      ) {
        throw err;
      }
      console.error(
        `[sdk] cloud agent slots are full; waiting ${delay / 1000}s ` +
          `(attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}): ${message}`,
      );
      await sleep(delay);
    }
  }
}

function createOptions(opts: AgentRunOptions) {
  const model = { id: process.env.CURSOR_MODEL ?? "composer-2.5" };
  if (opts.runtime === "local") {
    return {
      apiKey: opts.apiKey,
      model,
      name: opts.name,
      local: { cwd: opts.cwd },
    };
  }
  return {
    apiKey: opts.apiKey,
    model,
    name: opts.name,
    idempotencyKey: opts.idempotencyKey,
    cloud: {
      repos: [
        {
          url: opts.repoUrl,
          startingRef: opts.startingRef,
          ...(opts.prUrl ? { prUrl: opts.prUrl } : {}),
        },
      ],
      autoCreatePR: opts.autoCreatePR,
      skipReviewerRequest: true,
      metadata: { purpose: opts.name },
    },
  };
}

async function streamAndWait(agent: SDKAgent, prompt: string, apiKey: string) {
  const run = await agent.send(prompt);
  console.error(`[sdk] agentId=${agent.agentId} runId=${run.id}`);

  // ストリームは落ちうる。ここで読めた分は回収経路の保険として持っておく。
  let streamed = "";
  if (run.supports("stream")) {
    try {
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") {
              streamed += block.text;
              process.stdout.write(block.text);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[sdk] the run stream ended early: ${messageOf(err)}`);
    }
    process.stdout.write("\n");
  }

  type WaitResult = Awaited<ReturnType<typeof run.wait>>;
  let result: WaitResult;
  try {
    result = await run.wait();
  } catch (err) {
    result = {
      id: run.id,
      status: "error",
      error: { message: messageOf(err) },
    } as WaitResult;
  }

  if (result.status === "error") {
    const detail = result.error?.message ?? "";
    if (STREAM_GONE.test(detail)) {
      const recovered = await recoverFinishedRun(apiKey, agent.agentId);
      if (recovered) {
        console.error(
          `[sdk] the run stream was released before we finished reading it; ` +
            `recovered the result from the agent's conversation (${agent.agentId})`,
        );
        const text = recovered.text || streamed;
        return {
          runId: result.id,
          text,
          prUrl: recovered.prUrl ?? prUrlIn(text),
          branch: recovered.branch,
        };
      }
    }
    const err = new Error(`run failed: ${result.id}${detail ? ` (${detail})` : ""}`);
    (err as Error & { exitCode: number }).exitCode = 2;
    throw err;
  }

  const branch = result.git?.branches?.[0];
  const text = result.result ?? streamed;
  return {
    runId: result.id,
    text,
    prUrl: branch?.prUrl ?? prUrlIn(text),
    branch: branch?.branch,
  };
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunOutcome> {
  try {
    await using agent = await createWithRetry(opts);
    const result = await streamAndWait(agent, opts.prompt, opts.apiKey);
    return { agentId: agent.agentId, ...result };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      const wrapped = new Error(
        `startup failed: ${err.message} retryable=${err.isRetryable}`,
      );
      (wrapped as Error & { exitCode: number }).exitCode = 1;
      throw wrapped;
    }
    throw err;
  }
}

export async function resumeAgent(opts: {
  apiKey: string;
  agentId: string;
  prompt: string;
  cwd: string;
}): Promise<AgentRunOutcome> {
  try {
    const resumeOpts = opts.agentId.startsWith("bc-")
      ? { apiKey: opts.apiKey, model: { id: process.env.CURSOR_MODEL ?? "composer-2.5" } }
      : {
          apiKey: opts.apiKey,
          model: { id: process.env.CURSOR_MODEL ?? "composer-2.5" },
          local: { cwd: opts.cwd },
        };
    await using agent = await Agent.resume(opts.agentId, resumeOpts);
    const result = await streamAndWait(agent, opts.prompt, opts.apiKey);
    return { agentId: agent.agentId, ...result };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      const wrapped = new Error(
        `startup failed: ${err.message} retryable=${err.isRetryable}`,
      );
      (wrapped as Error & { exitCode: number }).exitCode = 1;
      throw wrapped;
    }
    throw err;
  }
}
