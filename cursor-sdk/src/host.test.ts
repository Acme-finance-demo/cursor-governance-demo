import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHost, hostFromUrl, normalizeRepoUrl, resolveHostContext } from "./host.ts";

const noRemote = () => undefined;

test("detectHost reads GitHub Actions env", () => {
  assert.equal(detectHost({ GITHUB_ACTIONS: "true" }), "github");
  assert.equal(detectHost({ GITHUB_REPOSITORY: "acme/app" }), "github");
});

test("detectHost reads GitLab CI env", () => {
  assert.equal(detectHost({ GITLAB_CI: "true" }), "gitlab");
  assert.equal(detectHost({ CI_PROJECT_URL: "https://gitlab.com/acme/app" }), "gitlab");
});

test("detectHost lets VULN_HOST win and stays undefined off CI", () => {
  assert.equal(detectHost({ VULN_HOST: "gitlab", GITHUB_ACTIONS: "true" }), "gitlab");
  assert.equal(detectHost({}), undefined);
});

test("normalizeRepoUrl drops .git and rewrites SSH forms", () => {
  assert.equal(
    normalizeRepoUrl("git@github.com:acme/app.git"),
    "https://github.com/acme/app",
  );
  assert.equal(
    normalizeRepoUrl("ssh://git@gitlab.com/acme/app.git"),
    "https://gitlab.com/acme/app",
  );
  assert.equal(normalizeRepoUrl("https://github.com/acme/app/"), "https://github.com/acme/app");
  assert.equal(normalizeRepoUrl(" "), undefined);
});

test("hostFromUrl reads the forge out of a clone URL", () => {
  assert.equal(hostFromUrl("https://github.com/acme/app"), "github");
  assert.equal(hostFromUrl("https://gitlab.example.com/acme/app"), "gitlab");
  assert.equal(hostFromUrl("https://git.acme.dev/app"), undefined);
});

test("resolveHostContext maps GitHub Actions env", () => {
  const ctx = resolveHostContext({
    cwd: "/repo",
    gitRemote: noRemote,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SHA: "abc123",
      GITHUB_RUN_ID: "42",
    },
  });
  assert.equal(ctx.host, "github");
  assert.equal(ctx.repoUrl, "https://github.com/acme/app");
  assert.equal(ctx.startingRef, "abc123");
  assert.equal(ctx.sha, "abc123");
  assert.equal(ctx.pipelineId, "42");
  assert.equal(ctx.vocab.pr, "pull request");
  assert.equal(ctx.vocab.prShort, "PR");
});

test("resolveHostContext maps GitLab CI env", () => {
  const ctx = resolveHostContext({
    cwd: "/repo",
    gitRemote: noRemote,
    env: {
      GITLAB_CI: "true",
      CI_PROJECT_URL: "https://gitlab.com/acme/app",
      CI_COMMIT_SHA: "def456",
      CI_PIPELINE_ID: "7",
    },
  });
  assert.equal(ctx.host, "gitlab");
  assert.equal(ctx.repoUrl, "https://gitlab.com/acme/app");
  assert.equal(ctx.startingRef, "def456");
  assert.equal(ctx.pipelineId, "7");
  assert.equal(ctx.vocab.pr, "merge request");
  assert.equal(ctx.vocab.prShort, "MR");
});

test("resolveHostContext falls back to the origin remote off CI", () => {
  const ctx = resolveHostContext({
    cwd: "/repo",
    env: {},
    gitRemote: () => "git@github.com:acme/app.git",
  });
  assert.equal(ctx.host, "github");
  assert.equal(ctx.repoUrl, "https://github.com/acme/app");
  assert.equal(ctx.startingRef, "main");
});

test("CURSOR_REPO_URL and CURSOR_STARTING_REF win over CI variables", () => {
  const ctx = resolveHostContext({
    cwd: "/repo",
    gitRemote: noRemote,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SHA: "abc123",
      CURSOR_REPO_URL: "https://github.com/acme/fork.git",
      CURSOR_STARTING_REF: "release",
    },
  });
  assert.equal(ctx.repoUrl, "https://github.com/acme/fork");
  assert.equal(ctx.startingRef, "release");
});

test("GitHub prefers the branch name over the commit SHA as the starting ref", () => {
  const ctx = resolveHostContext({
    cwd: "/repo",
    gitRemote: noRemote,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_REF_NAME: "feature-branch",
      GITHUB_SHA: "abc123",
    },
  });
  // Cursor の ref 検証が push 直後の SHA を解決できないため、ブランチ名を使う
  assert.equal(ctx.startingRef, "feature-branch");
  // 冪等キー用の sha は SHA のまま
  assert.equal(ctx.sha, "abc123");
});

test("GitLab keeps the commit SHA as the starting ref", () => {
  const ctx = resolveHostContext({
    cwd: "/repo",
    gitRemote: noRemote,
    env: {
      GITLAB_CI: "true",
      CI_PROJECT_URL: "https://gitlab.com/acme/app",
      CI_COMMIT_REF_NAME: "feature-branch",
      CI_COMMIT_SHA: "def456",
    },
  });
  assert.equal(ctx.startingRef, "def456");
});
