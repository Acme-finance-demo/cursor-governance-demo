import assert from "node:assert/strict";
import { test } from "node:test";
import { findOpenRequestFor, shortPackageName } from "./open-requests.ts";

const request = (title: string, body = "", branch = "cursor/remediate-x") => ({
  url: "https://github.com/acme/app/pull/1",
  title,
  body,
  branch,
});

test("shortPackageName keeps the artifact, not the group", () => {
  assert.equal(shortPackageName("org.apache.logging.log4j:log4j-core"), "log4j-core");
  assert.equal(shortPackageName("github.com/gin-gonic/gin"), "gin");
  assert.equal(shortPackageName("minimist"), "minimist");
});

test("finds the request the agent opened for this package", () => {
  const requests = [request("fix(deps): bump log4j-core 2.14.1 → 2.26.1")];
  const found = findOpenRequestFor(requests, "org.apache.logging.log4j:log4j-core");
  assert.equal(found?.url, "https://github.com/acme/app/pull/1");
});

test("matches on the full coordinate in the body too", () => {
  const requests = [
    request("fix(deps): CVE remediation", "upgrades `org.apache.commons:commons-text` to 1.10.0"),
  ];
  assert.ok(findOpenRequestFor(requests, "org.apache.commons:commons-text"));
});

test("a different package is not a match", () => {
  const requests = [request("fix(deps): bump log4j-core 2.14.1 → 2.26.1")];
  assert.equal(findOpenRequestFor(requests, "com.fasterxml.jackson.core:jackson-databind"), undefined);
});

test("a longer name that merely contains the package is not a match", () => {
  // `crypto` must not match a pull request about `crypto-js`.
  const requests = [request("fix(deps): bump crypto-js to 4.2.0")];
  assert.equal(findOpenRequestFor(requests, "crypto"), undefined);
  assert.ok(findOpenRequestFor(requests, "crypto-js"));
});

test("very short package names are ignored rather than guessed at", () => {
  const requests = [request("fix(deps): bump go to 1.25")];
  assert.equal(findOpenRequestFor(requests, "go"), undefined);
});

test("no open requests means nothing is skipped", () => {
  assert.equal(findOpenRequestFor([], "minimist"), undefined);
});
