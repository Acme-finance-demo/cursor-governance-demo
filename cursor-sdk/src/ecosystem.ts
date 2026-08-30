import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { EcosystemId, EcosystemProfile } from "./types.ts";

/** マニフェストのファイル名 → エコシステム。 */
const MANIFESTS: Record<string, EcosystemId> = {
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  "package.json": "npm",
  "package-lock.json": "npm",
  "yarn.lock": "npm",
  "pnpm-lock.yaml": "npm",
  "go.mod": "go",
  "go.sum": "go",
  "requirements.txt": "python",
  "poetry.lock": "python",
  "Pipfile.lock": "python",
};

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "vendor",
  ".gradle",
  ".venv",
  "__pycache__",
]);

const PROFILES: Record<EcosystemId, Omit<EcosystemProfile, "manifests">> = {
  maven: {
    id: "maven",
    label: "Maven (Java)",
    upgradeRules: [
      "Prefer existing BOM / parent-managed versions and pom properties (e.g. `<thymeleaf.version>`) over ad-hoc `<dependency>` pins.",
      "Do not change the parent POM's major version.",
    ],
    testCommands: ["./mvnw test -Dtest=<TestClass>", "./mvnw verify"],
  },
  gradle: {
    id: "gradle",
    label: "Gradle (Java/Kotlin)",
    upgradeRules: [
      "Prefer the version catalog (`gradle/libs.versions.toml`) or a platform BOM constraint over a hard-coded dependency version.",
      "Do not change the Gradle wrapper version.",
    ],
    testCommands: ["./gradlew test --tests '<TestClass>'", "./gradlew build"],
  },
  npm: {
    id: "npm",
    label: "npm (JavaScript/TypeScript)",
    upgradeRules: [
      "If the existing semver range already allows the fixed version, update the lockfile only. Widen the range in `package.json` just when the range excludes the fix.",
      "Keep `package.json` and the lockfile consistent, and keep using the lockfile that is already committed (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`). Do not switch package managers.",
      "Transitive-only findings are usually fixed by refreshing the lockfile or by an `overrides` / `resolutions` entry as a last resort.",
    ],
    testCommands: ["npm ci && npm test", "npm audit --production"],
  },
  go: {
    id: "go",
    label: "Go modules",
    upgradeRules: [
      "Use `go get <module>@v<version>` followed by `go mod tidy`. Commit both `go.mod` and `go.sum`.",
      "Do not raise the `go` language directive in `go.mod` unless the fixed version requires it.",
    ],
    testCommands: ["go build ./...", "go test ./..."],
  },
  python: {
    id: "python",
    label: "Python",
    upgradeRules: [
      "Change the version through whichever file owns it (`requirements.txt`, `poetry.lock` via `poetry update <pkg>`, `Pipfile.lock` via `pipenv update <pkg>`). Do not hand-edit a lockfile.",
    ],
    testCommands: ["pytest"],
  },
  unknown: {
    id: "unknown",
    label: "unknown ecosystem",
    upgradeRules: [
      "Identify the dependency manifest yourself before editing anything, and make the smallest possible change.",
    ],
    testCommands: ["whatever this repository's README documents"],
  },
};

function walk(dir: string, root: string, depth: number, found: Map<EcosystemId, Set<string>>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (depth <= 0 || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), root, depth - 1, found);
      continue;
    }
    const id = MANIFESTS[entry.name];
    if (!id) continue;
    const paths = found.get(id) ?? new Set<string>();
    paths.add(relative(root, join(dir, entry.name)) || entry.name);
    found.set(id, paths);
  }
}

/**
 * リポジトリ直下から数階層だけ見てエコシステムを判定する。
 * モノレポ（例: go-gin/go.mod と vue-js/package.json）は複数返る。
 */
export function detectEcosystems(cwd: string, depth = 2): EcosystemProfile[] {
  const found = new Map<EcosystemId, Set<string>>();
  walk(cwd, cwd, depth, found);
  if (found.size === 0) return [{ ...PROFILES.unknown, manifests: [] }];
  return [...found.entries()].map(([id, paths]) => ({
    ...PROFILES[id],
    manifests: [...paths].sort(),
  }));
}

/** プロンプトに差し込む説明文。 */
export function describeEcosystems(profiles: EcosystemProfile[]): string {
  return profiles
    .map((profile) => {
      const manifests = profile.manifests.length
        ? profile.manifests.map((m) => `\`${m}\``).join(", ")
        : "(no manifest found)";
      const rules = profile.upgradeRules.map((rule) => `  - ${rule}`).join("\n");
      return `- ${profile.label} — manifests: ${manifests}\n${rules}`;
    })
    .join("\n");
}

export function testCommandsFor(profiles: EcosystemProfile[]): string {
  return profiles
    .map((profile) => `- ${profile.label}: ${profile.testCommands.map((c) => `\`${c}\``).join(" / ")}`)
    .join("\n");
}
