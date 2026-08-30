import type { PolicyDecision, TriageItem } from "./types.ts";

/** Live-extend hook: add "HIGH" here to auto-remediate that severity too. */
export const AUTO_REMEDIATE_SEVERITIES = new Set(["CRITICAL"]);

function normalizeSeverity(severity: string): string {
  return severity.trim().toUpperCase();
}

function majorVersion(version: string): number | null {
  const match = version.replace(/^[^0-9]*/, "").match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function numericParts(version: string): number[] {
  return version
    .replace(/^[^0-9]*/, "")
    .split(/[^0-9]+/)
    .filter((part) => part.length > 0)
    .map(Number);
}

/**
 * 推奨バージョンが現在より低いか。
 * Trivy の FixedVersion は "2.5.4, 3.0.4, 4.0.4" のように複数候補を返すことがあり、
 * トリアージがそこから古い系列を選ぶとダウングレードになる。
 */
export function isDowngrade(
  currentVersion: string,
  recommendedVersion: string | null,
): boolean {
  if (!recommendedVersion) return false;
  const current = numericParts(currentVersion);
  const recommended = numericParts(recommendedVersion);
  if (current.length === 0 || recommended.length === 0) return false;
  for (let i = 0; i < Math.max(current.length, recommended.length); i += 1) {
    const a = recommended[i] ?? 0;
    const b = current[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

export function isMajorBump(
  currentVersion: string,
  recommendedVersion: string | null,
): boolean {
  if (!recommendedVersion) return false;
  const current = majorVersion(currentVersion);
  const recommended = majorVersion(recommendedVersion);
  if (current === null || recommended === null) return false;
  return recommended > current;
}

export function decide(item: TriageItem): PolicyDecision {
  const severity = normalizeSeverity(item.severity);
  if (!AUTO_REMEDIATE_SEVERITIES.has(severity)) {
    return {
      action: "comment_only",
      reason: `severity ${severity} is outside the auto-remediate set`,
      item,
    };
  }
  if (!item.canFixByVersionBump || !item.recommendedVersion) {
    return {
      action: "comment_only",
      reason: "no safe version bump is available",
      item,
    };
  }
  if (isDowngrade(item.currentVersion, item.recommendedVersion)) {
    return {
      action: "comment_only",
      reason: `${item.recommendedVersion} is older than ${item.currentVersion}; not a valid upgrade`,
      item,
    };
  }
  if (
    item.isMajorBump ||
    isMajorBump(item.currentVersion, item.recommendedVersion)
  ) {
    return {
      action: "comment_only",
      reason: `major bump ${item.currentVersion} → ${item.recommendedVersion} needs a human`,
      item,
    };
  }
  return {
    action: "auto_remediate",
    reason: `CRITICAL patch/minor bump ${item.currentVersion} → ${item.recommendedVersion}`,
    item,
  };
}

export function decideAll(items: TriageItem[]): PolicyDecision[] {
  return items.map(decide);
}
