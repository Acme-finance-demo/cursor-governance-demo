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
const RETRY_DELAYS_MS = [60_000, 120_000, 180_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function streamAndWait(agent: SDKAgent, prompt: string) {
  const run = await agent.send(prompt);
  console.error(`[sdk] agentId=${agent.agentId} runId=${run.id}`);

  if (run.supports("stream")) {
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") process.stdout.write(block.text);
        }
      }
    }
    process.stdout.write("\n");
  }

  const result = await run.wait();
  if (result.status === "error") {
    const err = new Error(
      `run failed: ${result.id}${result.error?.message ? ` (${result.error.message})` : ""}`,
    );
    (err as Error & { exitCode: number }).exitCode = 2;
    throw err;
  }

  const branch = result.git?.branches?.[0];
  return {
    runId: result.id,
    text: result.result ?? "",
    prUrl: branch?.prUrl,
    branch: branch?.branch,
  };
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunOutcome> {
  try {
    await using agent = await createWithRetry(opts);
    const result = await streamAndWait(agent, opts.prompt);
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
    const result = await streamAndWait(agent, opts.prompt);
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
