import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeEcosystems, detectEcosystems } from "./ecosystem.ts";

function fixture(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "eco-"));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return root;
}

test("detects a monorepo with several ecosystems", () => {
  const root = fixture(["go-gin/go.mod", "go-gin/go.sum", "vue-js/package.json", "vue-js/package-lock.json"]);
  const ids = detectEcosystems(root).map((e) => e.id).sort();
  assert.deepEqual(ids, ["go", "npm"]);
});

test("reports the manifests it found", () => {
  const root = fixture(["pom.xml", "build.gradle"]);
  const profiles = detectEcosystems(root);
  const maven = profiles.find((e) => e.id === "maven");
  assert.deepEqual(maven?.manifests, ["pom.xml"]);
  assert.ok(profiles.some((e) => e.id === "gradle"));
});

test("skips node_modules and build output", () => {
  const root = fixture(["node_modules/left-pad/package.json", "target/classes/pom.xml"]);
  assert.deepEqual(detectEcosystems(root).map((e) => e.id), ["unknown"]);
});

test("falls back to unknown with no manifests", () => {
  const root = fixture(["README.md"]);
  const profiles = detectEcosystems(root);
  assert.equal(profiles[0]?.id, "unknown");
  assert.deepEqual(profiles[0]?.manifests, []);
});

test("describeEcosystems renders manifests and rules for the prompt", () => {
  const root = fixture(["package.json"]);
  const text = describeEcosystems(detectEcosystems(root));
  assert.match(text, /npm \(JavaScript\/TypeScript\)/);
  assert.match(text, /`package\.json`/);
  assert.match(text, /lockfile/);
});
