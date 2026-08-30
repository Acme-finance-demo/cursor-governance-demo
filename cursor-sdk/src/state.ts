import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OrchestratorState } from "./types.ts";

export function defaultStatePath(repoRoot: string): string {
  return join(repoRoot, ".cursor", "vuln-orchestrator-state.json");
}

export async function writeState(
  path: string,
  state: OrchestratorState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function readState(path: string): Promise<OrchestratorState> {
  return JSON.parse(await readFile(path, "utf8")) as OrchestratorState;
}
