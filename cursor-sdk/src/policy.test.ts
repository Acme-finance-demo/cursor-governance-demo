import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByPackage, parseFindings } from "./parse-report.ts";
import { decide, isDowngrade, isMajorBump } from "./policy.ts";
import type { TriageItem } from "./types.ts";

test("parseFindings reads native Trivy JSON", () => {
  const findings = parseFindings({
    Results: [
      {
        Vulnerabilities: [
          {
            VulnerabilityID: "CVE-2026-1",
            Severity: "CRITICAL",
            Title: "tomcat",
            Description: "x",
            FixedVersion: "10.1.55",
            InstalledVersion: "10.1.44",
            PkgIdentifier: {
              PURL: "pkg:maven/org.apache.tomcat.embed/tomcat-embed-core@10.1.44",
            },
          },
        ],
      },
    ],
  });
  assert.equal(findings[0]?.package, "org.apache.tomcat.embed:tomcat-embed-core");
  assert.equal(findings[0]?.version, "10.1.44");
  assert.equal(findings[0]?.id, "CVE-2026-1");
});

test("parseFindings reads GitLab container_scanning locations", () => {
  const findings = parseFindings({
    vulnerabilities: [
      {
        id: "CVE-2026-1",
        severity: "Critical",
        name: "tomcat",
        description: "x",
        solution: "Upgrade to 10.1.55",
        location: {
          dependency: {
            package: { name: "org.apache.tomcat.embed:tomcat-embed-core" },
            version: "10.1.44",
          },
        },
      },
    ],
  });
  assert.equal(findings[0]?.package, "org.apache.tomcat.embed:tomcat-embed-core");
  assert.equal(findings[0]?.version, "10.1.44");
});

test("parseFindings reads the flattened webhook shape", () => {
  const findings = parseFindings({
    vulnerabilities: [
      {
        id: "CVE-1",
        severity: "Critical",
        package: "commons-lang:commons-lang",
        version: "2.6",
      },
    ],
  });
  assert.equal(findings[0]?.package, "commons-lang:commons-lang");
});

test("groupByPackage collapses duplicate CVEs on the same GAV", () => {
  const groups = groupByPackage([
    {
      id: "CVE-1",
      severity: "Critical",
      name: "",
      description: "",
      solution: "",
      package: "a:b",
      version: "1.0",
    },
    {
      id: "CVE-2",
      severity: "Critical",
      name: "",
      description: "",
      solution: "",
      package: "a:b",
      version: "1.0",
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.findings.length, 2);
});

function item(overrides: Partial<TriageItem>): TriageItem {
  return {
    package: "org.apache.tomcat.embed:tomcat-embed-core",
    currentVersion: "10.1.44",
    recommendedVersion: "10.1.55",
    cves: ["CVE-2026-43515"],
    severity: "CRITICAL",
    isDirectDependency: false,
    isMajorBump: false,
    canFixByVersionBump: true,
    notes: "",
    ...overrides,
  };
}

test("policy auto-remediates CRITICAL patch bumps", () => {
  assert.equal(decide(item({})).action, "auto_remediate");
});

test("policy defers major bumps even when the agent says it is safe", () => {
  const decision = decide(
    item({
      currentVersion: "3.5.0",
      recommendedVersion: "4.0.0",
      isMajorBump: false,
    }),
  );
  assert.equal(decision.action, "comment_only");
});

test("policy defers findings without a fixed version", () => {
  assert.equal(
    decide(item({ recommendedVersion: null, canFixByVersionBump: false })).action,
    "comment_only",
  );
});

test("isMajorBump uses the first numeric component", () => {
  assert.equal(isMajorBump("10.1.44", "10.1.55"), false);
  assert.equal(isMajorBump("3.5.0", "4.0.1"), true);
});

test("policy rejects a downgrade picked from a multi-value FixedVersion", () => {
  // Trivy の form-data の FixedVersion は "2.5.4, 3.0.4, 4.0.4"。
  // 4.0.0 に対して 2.5.4 を選んでしまった場合は上げるべきではない。
  const decision = decide({
    package: "form-data",
    currentVersion: "4.0.0",
    recommendedVersion: "2.5.4",
    cves: ["CVE-2026-1"],
    severity: "CRITICAL",
    isDirectDependency: true,
    isMajorBump: false,
    canFixByVersionBump: true,
    notes: "",
  });
  assert.equal(decision.action, "comment_only");
  assert.match(decision.reason, /older than/);
});

test("isDowngrade compares every numeric component", () => {
  assert.equal(isDowngrade("4.0.0", "4.0.4"), false);
  assert.equal(isDowngrade("4.0.0", "2.5.4"), true);
  assert.equal(isDowngrade("1.4.1", "1.4.1"), false);
  assert.equal(isDowngrade("v1.6.0", "v1.4.0"), true);
  assert.equal(isDowngrade("3.1.3.RELEASE", "3.1.5.RELEASE"), false);
  assert.equal(isDowngrade("1.0.0", null), false);
});
