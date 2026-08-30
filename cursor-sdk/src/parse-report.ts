import type { Finding, PackageGroup } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function mavenNameFromPurl(purl: string): string | undefined {
  const match = purl.match(/^pkg:maven\/([^/]+)\/([^@?]+)/);
  if (!match) return undefined;
  return `${match[1]}:${match[2]}`;
}

function packageName(vuln: UnknownRecord): string {
  if (typeof vuln.package === "string") return vuln.package;
  const ident = asRecord(vuln.PkgIdentifier);
  const fromPurl = mavenNameFromPurl(asString(ident?.PURL));
  if (fromPurl) return fromPurl;
  if (typeof vuln.PkgName === "string" && vuln.PkgName.length > 0) {
    return vuln.PkgName;
  }
  const location = asRecord(vuln.location);
  const dependency = asRecord(location?.dependency);
  const pkg = asRecord(dependency?.package);
  return asString(pkg?.name, "unknown");
}

function packageVersion(vuln: UnknownRecord): string {
  if (typeof vuln.version === "string") return vuln.version;
  if (typeof vuln.InstalledVersion === "string") return vuln.InstalledVersion;
  const location = asRecord(vuln.location);
  const dependency = asRecord(location?.dependency);
  return asString(dependency?.version, "unknown");
}

function collectVulnRecords(raw: unknown): UnknownRecord[] {
  const root = asRecord(raw);
  if (Array.isArray(root?.Results)) {
    return root.Results.flatMap((result) => {
      const rec = asRecord(result);
      const list = rec?.Vulnerabilities;
      if (!Array.isArray(list)) return [];
      return list.flatMap((entry) => {
        const vuln = asRecord(entry);
        return vuln ? [vuln] : [];
      });
    });
  }
  const list = Array.isArray(root?.vulnerabilities)
    ? root.vulnerabilities
    : Array.isArray(raw)
      ? raw
      : [];
  return list.flatMap((entry) => {
    const vuln = asRecord(entry);
    return vuln ? [vuln] : [];
  });
}

export function parseFindings(raw: unknown): Finding[] {
  return collectVulnRecords(raw).map((vuln) => {
    const fixed = asString(vuln.FixedVersion);
    return {
      id: asString(vuln.VulnerabilityID, asString(vuln.id, asString(vuln.cve, "unknown"))),
      severity: asString(vuln.Severity, asString(vuln.severity, "UNKNOWN")),
      name: asString(vuln.Title, asString(vuln.name)),
      description: asString(vuln.Description, asString(vuln.description)),
      solution: asString(vuln.solution, fixed ? `Upgrade to ${fixed}` : ""),
      package: packageName(vuln),
      version: packageVersion(vuln),
    };
  });
}

export function groupByPackage(findings: Finding[]): PackageGroup[] {
  const groups = new Map<string, PackageGroup>();
  for (const finding of findings) {
    const key = `${finding.package}@${finding.version}`;
    const existing = groups.get(key);
    if (existing) {
      existing.findings.push(finding);
      continue;
    }
    groups.set(key, {
      package: finding.package,
      version: finding.version,
      findings: [finding],
    });
  }
  return [...groups.values()];
}
