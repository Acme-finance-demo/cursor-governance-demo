#!/usr/bin/env python3
"""snapshot.json を、静的な 1 枚の HTML レポートに落とす。

入力:
  snapshot.json   collect-snapshot.py の出力

出力:
  <out>/index.html   外部依存ゼロ。データは JSON として埋め込む。

このページは断面であって監視画面ではない。生成時点の検出結果をそのまま焼き込み、
いつ検査した結果なのかをページ上に必ず出す。
"""

import argparse
import html
import json
import pathlib
from datetime import datetime, timezone

SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM")

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$title</title>
<meta name="description" content="$description">
<style>
:root {
  color-scheme: light;
  --plane:          #f9f9f7;
  --surface-1:      #fcfcfb;
  --text-primary:   #0b0b0b;
  --text-secondary: #52514e;
  --text-muted:     #898781;
  --grid:           #e1e0d9;
  --baseline:       #c3c2b7;
  --border:         rgba(11, 11, 11, 0.10);
  --series-1:       #2a78d6;
  --series-1-wash:  rgba(42, 120, 214, 0.10);
  --good:           #0ca30c;
  --good-ink:       #006300;
  --sev-critical:   #d03b3b;
  --sev-high:       #ec835a;
  --sev-medium:     #fab219;
  --shadow:         0 1px 2px rgba(11, 11, 11, 0.04);
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --plane:          #0d0d0d;
    --surface-1:      #1a1a19;
    --text-primary:   #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted:     #898781;
    --grid:           #2c2c2a;
    --baseline:       #383835;
    --border:         rgba(255, 255, 255, 0.10);
    --series-1:       #3987e5;
    --series-1-wash:  rgba(57, 135, 229, 0.16);
    --good:           #0ca30c;
    --good-ink:       #0ca30c;
    --shadow:         none;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane:          #0d0d0d;
  --surface-1:      #1a1a19;
  --text-primary:   #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted:     #898781;
  --grid:           #2c2c2a;
  --baseline:       #383835;
  --border:         rgba(255, 255, 255, 0.10);
  --series-1:       #3987e5;
  --series-1-wash:  rgba(57, 135, 229, 0.16);
  --good:           #0ca30c;
  --good-ink:       #0ca30c;
  --shadow:         none;
}

* { box-sizing: border-box; }
html { background: var(--plane); }
body {
  margin: 0;
  padding: 0 24px 64px;
  background: var(--plane);
  color: var(--text-primary);
  font: 400 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1180px; margin: 0 auto; }
a { color: var(--series-1); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { color: var(--text-primary); }

/* ---------- masthead ---------- */
.masthead { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end;
  justify-content: space-between; padding: 40px 0 8px; }
.masthead h1 { margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }
.masthead .org { margin: 4px 0 0; color: var(--text-secondary); font-size: 14px; }
.masthead .org b { color: var(--text-primary); font-weight: 600; }
.provenance { color: var(--text-muted); font-size: 13px; text-align: right; line-height: 1.7; }
.provenance strong { color: var(--text-secondary); font-weight: 500; }
.theme-toggle { margin-top: 8px; }
button.ghost {
  font: inherit; font-size: 13px; color: var(--text-secondary);
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 8px; padding: 5px 10px; cursor: pointer;
}
button.ghost:hover { color: var(--text-primary); border-color: var(--baseline); }

.snapshot-note {
  margin: 20px 0 0; padding: 12px 16px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--surface-1); box-shadow: var(--shadow);
  color: var(--text-secondary); font-size: 13.5px;
}
.snapshot-note b { color: var(--text-primary); font-weight: 600; }

/* ---------- hero + tiles ---------- */
.hero-row { display: grid; grid-template-columns: minmax(230px, 0.9fr) 2fr;
  gap: 16px; margin-top: 24px; align-items: stretch; }
.card {
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 12px; padding: 18px 20px; box-shadow: var(--shadow);
}
.hero { display: flex; flex-direction: column; justify-content: center; }
.hero .label { color: var(--text-secondary); font-size: 13.5px; }
.hero .figure { font-size: 60px; line-height: 1.05; font-weight: 600;
  letter-spacing: -0.02em; margin: 6px 0 2px; }
.hero .sub { color: var(--text-muted); font-size: 13px; }

.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
@media (max-width: 860px) {
  .hero-row { grid-template-columns: 1fr; }
  .tiles { grid-template-columns: repeat(2, 1fr); }
}
.tile { display: flex; flex-direction: column; }
.tile .label { display: flex; align-items: center; gap: 7px;
  color: var(--text-secondary); font-size: 13px; }
.tile .value { font-size: 30px; font-weight: 600; letter-spacing: -0.01em; margin: 4px 0 0; }
.tile .sub { color: var(--text-muted); font-size: 12.5px; }

/* severity icon: shape differs per level, so hue is never the only cue */
.sev-icon { flex: none; display: inline-block; vertical-align: -2px; }
.sev-swatch { width: 11px; height: 11px; flex: none; }

/* ---------- filters ---------- */
.filters {
  display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center;
  margin: 28px 0 0; padding: 12px 16px;
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 12px; box-shadow: var(--shadow);
}
.filters .group { display: flex; align-items: center; gap: 8px; }
.filters .glabel { color: var(--text-muted); font-size: 12.5px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: 999px;
  padding: 4px 11px 4px 9px; cursor: pointer; user-select: none;
  background: transparent;
}
.chip:hover { border-color: var(--baseline); color: var(--text-primary); }
.chip[aria-pressed="true"] { color: var(--text-primary); border-color: var(--baseline);
  background: var(--grid); font-weight: 500; }
.chip .tick { width: 12px; font-weight: 700; color: var(--text-primary); }
.chip[aria-pressed="false"] .tick { visibility: hidden; }
select, input[type="search"] {
  font: inherit; font-size: 13px; color: var(--text-primary);
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 8px; padding: 5px 8px; max-width: 260px;
}
input[type="search"] { min-width: 200px; }
.filters .spacer { flex: 1 1 auto; }
.filters .count { color: var(--text-secondary); font-size: 13px; font-variant-numeric: tabular-nums; }

/* ---------- sections ---------- */
section { margin-top: 32px; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 2px; letter-spacing: -0.005em; }
.sub-head { color: var(--text-secondary); font-size: 13.5px; margin: 0 0 14px; }
.charts { display: grid; grid-template-columns: 1.25fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 960px) { .charts { grid-template-columns: 1fr; } }

/* ---------- legend ---------- */
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 14px; padding: 0; list-style: none; }
.legend li { display: flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--text-secondary); }

/* ---------- bar chart ---------- */
.bars { display: flex; flex-direction: column; gap: 12px; margin: 0; }
.bar-row { display: grid; grid-template-columns: 200px 1fr; gap: 12px; align-items: center; }
@media (max-width: 620px) { .bar-row { grid-template-columns: 110px 1fr; } }
.bar-name { font-size: 12.5px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-name .ref { color: var(--text-muted); }
.bar-lane { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bar-track { display: flex; flex: none; gap: 2px; height: 18px; min-width: 0; }
.bar-seg { position: relative; min-width: 3px; border: 0; padding: 0; cursor: default;
  border-radius: 0; transition: filter 120ms ease; }
.bar-seg::after { content: ""; position: absolute; inset: -5px -1px; }
.bar-seg:first-child { border-radius: 0; }
.bar-seg:last-child { border-top-right-radius: 4px; border-bottom-right-radius: 4px; }
.bar-seg:hover, .bar-seg:focus-visible { filter: brightness(1.12); outline: none; }
.bar-seg:focus-visible { box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--text-primary); }
.bar-value { font-size: 12.5px; color: var(--text-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-zero { font-size: 12.5px; color: var(--good-ink); white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px; }
.axis-note { margin: 14px 0 0; padding-top: 10px; border-top: 1px solid var(--grid);
  color: var(--text-muted); font-size: 12px; }

/* ---------- package bars (single series) ---------- */
.pkg-row { display: grid; grid-template-columns: 1fr; gap: 3px; }
.pkg-head { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.pkg-head .name { color: var(--text-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.pkg-head .n { color: var(--text-secondary); font-variant-numeric: tabular-nums; flex: none; }
.pkg-track { height: 8px; background: var(--series-1-wash); border-radius: 4px; }
.pkg-fill { height: 8px; background: var(--series-1);
  border-top-right-radius: 4px; border-bottom-right-radius: 4px; min-width: 3px; }

/* ---------- tooltip ---------- */
.tip {
  position: fixed; z-index: 30; pointer-events: none; opacity: 0;
  transition: opacity 90ms ease; max-width: 280px;
  background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--baseline); border-radius: 8px;
  padding: 8px 10px; font-size: 12.5px; line-height: 1.45;
  box-shadow: 0 6px 20px rgba(11, 11, 11, 0.16);
}
.tip[data-open="true"] { opacity: 1; }
.tip .tip-title { color: var(--text-secondary); font-size: 12px; margin-bottom: 4px; }
.tip .tip-row { display: flex; align-items: baseline; gap: 7px; }
.tip .tip-key { display: inline-block; width: 14px; height: 2px; flex: none;
  transform: translateY(-3px); }
.tip .tip-val { font-weight: 600; font-variant-numeric: tabular-nums; }
.tip .tip-name { color: var(--text-secondary); }

/* ---------- governance ---------- */
.gov { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
@media (max-width: 860px) { .gov { grid-template-columns: repeat(2, 1fr); } }
.pr-list { list-style: none; margin: 14px 0 0; padding: 0;
  display: flex; flex-direction: column; gap: 0; }
.pr-list li { display: flex; gap: 12px; align-items: baseline;
  padding: 9px 0; border-top: 1px solid var(--grid); font-size: 13.5px; }
.pr-list li:first-child { border-top: 0; }
.pr-list .pr-repo { flex: none; width: 190px; color: var(--text-secondary); font-size: 13px; }
.pr-list .pr-title { flex: 1 1 auto; min-width: 0; }
.pr-list .pr-num { flex: none; color: var(--text-muted); font-variant-numeric: tabular-nums; }
@media (max-width: 720px) {
  .pr-list li { flex-wrap: wrap; gap: 4px 10px; }
  .pr-list .pr-repo { width: auto; }
}

/* ---------- table ---------- */
.table-wrap { overflow-x: auto; border: 1px solid var(--border);
  border-radius: 12px; background: var(--surface-1); box-shadow: var(--shadow); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
thead th {
  position: sticky; top: 0; z-index: 2; text-align: left; white-space: nowrap;
  background: var(--surface-1); color: var(--text-secondary);
  font-weight: 500; font-size: 12px; padding: 10px 12px;
  border-bottom: 1px solid var(--baseline); cursor: pointer; user-select: none;
}
thead th:hover { color: var(--text-primary); }
thead th .arrow { color: var(--text-muted); font-size: 10px; margin-left: 3px; }
tbody td { padding: 9px 12px; border-top: 1px solid var(--grid); vertical-align: top; }
tbody td.nowrap { white-space: nowrap; }
tbody td.fix { min-width: 190px; }
tbody td.manifest .pill { margin-left: 7px; }
thead th:nth-child(3), tbody td:nth-child(3) { text-align: right; }
tbody tr:hover { background: var(--grid); }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; }
.sev-badge { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  font-size: 12px; font-weight: 500; color: var(--text-primary); }
.bump { color: var(--text-secondary); }
.bump b { color: var(--text-primary); font-weight: 600; }
.pill { display: inline-block; font-size: 11.5px; color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }
.table-foot { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between;
  align-items: center; margin-top: 12px; color: var(--text-muted); font-size: 12.5px; }
.empty { padding: 28px 16px; text-align: center; color: var(--text-secondary); }

footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--grid);
  color: var(--text-muted); font-size: 12.5px; line-height: 1.7; }
footer a { color: var(--text-secondary); }

/* Texture / forced-colors: hue is never the only channel. */
@media (forced-colors: active) {
  .bar-seg, .pkg-fill { forced-color-adjust: none; border: 1px solid ButtonBorder; }
  .bar-seg[data-sev="CRITICAL"] { background: repeating-linear-gradient(45deg,
      CanvasText 0 2px, Canvas 2px 4px) !important; }
  .bar-seg[data-sev="HIGH"] { background: repeating-linear-gradient(135deg,
      CanvasText 0 1px, Canvas 1px 5px) !important; }
  .bar-seg[data-sev="MEDIUM"] { background: Canvas !important; }
}
@media print {
  body { padding: 0; }
  .filters, .theme-toggle { display: none; }
  .card, .table-wrap { break-inside: avoid; }
}
</style>
</head>
<body data-palette="$palette">
<div class="wrap">

<header class="masthead">
  <div>
    <h1>$title</h1>
    <p class="org">Every repository owned by <b>$owner</b>, scanned in one pass.</p>
  </div>
  <div>
    <div class="provenance">
      Scanned <strong>$scanned_human</strong><br>
      Page built <strong>$generated_human</strong><br>
      $scanner_name &middot; <a href="$run_url">workflow run</a>
    </div>
    <div class="theme-toggle"><button class="ghost" id="theme-btn" type="button">Switch theme</button></div>
  </div>
</header>

<p class="snapshot-note">
  <b>This page is a snapshot, not a live dashboard.</b>
  The numbers below are the state of the fleet at the scan time above and do not
  change until the page is rebuilt. Findings come from $scanner_name running against
  each repository&rsquo;s default branch (except where a branch is pinned), and the
  remediation columns come from the policy the control plane applied in the same run.
</p>

<div class="hero-row">
  <div class="card hero">
    <span class="label">Open findings across the organization</span>
    <span class="figure" id="hero-figure">$total_findings</span>
    <span class="sub">$unique_cves distinct advisories &middot; $affected_packages affected packages</span>
  </div>
  <div class="tiles">
$severity_tiles
    <div class="card tile">
      <span class="label">Repositories in scope</span>
      <span class="value">$repo_count</span>
      <span class="sub">$clean_repos with no findings</span>
    </div>
    <div class="card tile">
      <span class="label">Fix pull requests open now</span>
      <span class="value">$agent_prs</span>
      <span class="sub">opened by the remediation agent</span>
    </div>
    <div class="card tile">
      <span class="label">Findings with a fix available</span>
      <span class="value">$fixable_pct%</span>
      <span class="sub">$fixable of $total_findings resolve by a version bump</span>
    </div>
  </div>
</div>

<div class="filters" role="group" aria-label="Filter every chart and table below">
  <div class="group">
    <span class="glabel">Severity</span>
$severity_chips
  </div>
  <div class="group">
    <span class="glabel"><label for="f-repo">Repository</label></span>
    <select id="f-repo"><option value="">All repositories</option>$repo_options</select>
  </div>
  <div class="group">
    <span class="glabel"><label for="f-eco">Ecosystem</label></span>
    <select id="f-eco"><option value="">All ecosystems</option>$eco_options</select>
  </div>
  <div class="group">
    <label class="glabel" for="f-q">Search</label>
    <input id="f-q" type="search" placeholder="Advisory or package" autocomplete="off">
  </div>
  <div class="spacer"></div>
  <span class="count" id="filter-count"></span>
  <button class="ghost" id="reset-btn" type="button">Reset</button>
</div>

<section>
  <h2>Where the findings are</h2>
  <p class="sub-head">Findings per repository, split by severity. Sorted by count; the
    value at each bar&rsquo;s end is the repository total.</p>
  <div class="charts">
    <div class="card">
      <ul class="legend" id="sev-legend">$severity_legend</ul>
      <div class="bars" id="repo-bars"></div>
      <p class="axis-note" id="repo-axis-note"></p>
    </div>
    <div class="card">
      <h2 style="font-size:14px;margin-bottom:10px">Most affected packages</h2>
      <div class="bars" id="pkg-bars" style="gap:11px"></div>
      <p class="axis-note" id="pkg-axis-note"></p>
    </div>
  </div>
</section>

<section>
  <h2>What the policy did about them</h2>
  <p class="sub-head">The control plane auto-remediates only CRITICAL findings that a
    non-major version bump fixes. Everything else is reported, never silently upgraded.
    These four numbers describe the scan above and are not affected by the filters.</p>
  <p class="sub-head">$coverage_note</p>
  <div class="gov">
    <div class="card tile">
      <span class="label">Auto-remediated</span>
      <span class="value">$auto_remediated</span>
      <span class="sub">package groups the policy allowed</span>
    </div>
    <div class="card tile">
      <span class="label">Left for a human</span>
      <span class="value">$deferred</span>
      <span class="sub">outside the auto-remediate set</span>
    </div>
    <div class="card tile">
      <span class="label">Already had a request open</span>
      <span class="value">$already_open</span>
      <span class="sub">no agent was started for these</span>
    </div>
    <div class="card tile">
      <span class="label">Repositories with a CRITICAL</span>
      <span class="value">$critical_repos</span>
      <span class="sub">of $repo_count in scope</span>
    </div>
  </div>
</section>

<section>
  <h2>Fix pull requests open right now</h2>
  <p class="sub-head">$pr_subhead</p>
  <div class="card"><ul class="pr-list">$pr_items</ul></div>
</section>

<section>
  <h2>Every finding</h2>
  <p class="sub-head">The full list behind the charts &mdash; the table view, so no value
    is reachable only by hovering. Click a column heading to sort.</p>
  <div class="table-wrap">
    <table id="findings-table">
      <thead><tr>
        <th data-sort="severity" scope="col">Severity<span class="arrow"></span></th>
        <th data-sort="cve" scope="col">Advisory<span class="arrow"></span></th>
        <th data-sort="cvss" scope="col">CVSS<span class="arrow"></span></th>
        <th data-sort="package" scope="col">Package<span class="arrow"></span></th>
        <th data-sort="fixed" scope="col">Fix<span class="arrow"></span></th>
        <th data-sort="repo" scope="col">Repository<span class="arrow"></span></th>
        <th data-sort="target" scope="col">Manifest<span class="arrow"></span></th>
      </tr></thead>
      <tbody id="findings-body"></tbody>
    </table>
  </div>
  <div class="table-foot">
    <span id="table-count"></span>
    <span>Severity and CVSS are $scanner_name&rsquo;s, from the advisory source it picked
      per package. Identifiers are CVE where one exists, otherwise the GitHub advisory (GHSA).</span>
  </div>
</section>

<footer>
  <p>
    Generated by <code>governance/render-vuln-page.py</code> in the vulnerability
    governance control plane. Rebuild it by re-running the generator against a newer
    <a href="$runs_url">fleet governance run</a>; nothing on this page updates on its own.
  </p>
  <p>
    $scanner_name scans for known vulnerabilities in resolved dependencies at
    CRITICAL, HIGH and MEDIUM severity. Counts are per finding, so one package with
    four advisories counts four times &mdash; the affected-package figure is the
    distinct count.
  </p>
</footer>

</div>
<div class="tip" id="tip" role="tooltip" aria-hidden="true"></div>
<script id="snapshot-data" type="application/json">$data_json</script>
<script>$script</script>
</body>
</html>
"""

SCRIPT = """
'use strict';

const SNAPSHOT = JSON.parse(document.getElementById('snapshot-data').textContent);
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM'];
const SEV_VAR = { CRITICAL: 'var(--sev-critical)', HIGH: 'var(--sev-high)', MEDIUM: 'var(--sev-medium)' };
const SEV_RANK = { CRITICAL: 3, HIGH: 2, MEDIUM: 1 };

// Shape carries the level as well as hue, so a status color never stands alone.
const SEV_SHAPE = {
  CRITICAL: '<rect x="1.4" y="1.4" width="13.2" height="13.2" rx="2.4"/>',
  HIGH: '<polygon points="8,1 15.4,14.4 0.6,14.4"/>',
  MEDIUM: '<circle cx="8" cy="8" r="6.6"/>'
};

function sevIcon(sev, size) {
  const px = size || 13;
  return '<svg class="sev-icon" width="' + px + '" height="' + px + '" viewBox="0 0 16 16" ' +
    'aria-hidden="true" fill="' + SEV_VAR[sev] + '">' + SEV_SHAPE[sev] + '</svg>';
}

const REPOS = new Map(SNAPSHOT.repos.map(r => [r.slug, r]));
const fmt = n => n.toLocaleString('en-US');

/* ---------------- filter state ---------------- */

const state = {
  severities: new Set(SEVERITIES),
  repo: '',
  ecosystem: '',
  query: '',
  sort: 'severity',
  dir: 'desc'
};

function matches(f) {
  if (!state.severities.has(f.severity)) return false;
  if (state.repo && f.repo !== state.repo) return false;
  if (state.ecosystem && f.ecosystem !== state.ecosystem) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    if (!(f.cve.toLowerCase().includes(q) || f.package.toLowerCase().includes(q) ||
          (f.title || '').toLowerCase().includes(q))) return false;
  }
  return true;
}

/* ---------------- tooltip ---------------- */

const tip = document.getElementById('tip');

function showTip(target, title, rows) {
  tip.textContent = '';
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  tip.appendChild(head);
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'tip-row';
    if (row.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = row.color;
      line.appendChild(key);
    }
    const val = document.createElement('span');
    val.className = 'tip-val';
    val.textContent = row.value;
    line.appendChild(val);
    const name = document.createElement('span');
    name.className = 'tip-name';
    name.textContent = row.label;
    line.appendChild(name);
    tip.appendChild(line);
  }
  const box = target.getBoundingClientRect();
  tip.dataset.open = 'true';
  tip.setAttribute('aria-hidden', 'false');
  const own = tip.getBoundingClientRect();
  let left = box.left + box.width / 2 - own.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - own.width - 8));
  let top = box.top - own.height - 8;
  if (top < 8) top = box.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTip() {
  tip.dataset.open = 'false';
  tip.setAttribute('aria-hidden', 'true');
}

/* ---------------- chart: findings per repository ---------------- */

const repoBars = document.getElementById('repo-bars');
const repoNote = document.getElementById('repo-axis-note');

function renderRepoBars(rows) {
  const byRepo = new Map();
  for (const repo of SNAPSHOT.repos) {
    byRepo.set(repo.slug, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, total: 0 });
  }
  for (const f of rows) {
    const bucket = byRepo.get(f.repo);
    if (!bucket) continue;
    bucket[f.severity] += 1;
    bucket.total += 1;
  }

  const entries = [...byRepo.entries()]
    .filter(([slug]) => !state.repo || slug === state.repo)
    .sort((a, b) => b[1].total - a[1].total ||
      a[0].localeCompare(b[0]));
  const max = Math.max(1, ...entries.map(([, c]) => c.total));

  repoBars.textContent = '';
  for (const [slug, counts] of entries) {
    const repo = REPOS.get(slug);
    const row = document.createElement('div');
    row.className = 'bar-row';

    const name = document.createElement('div');
    name.className = 'bar-name';
    name.textContent = repo.name;
    if (repo.ref && repo.ref !== 'main') {
      const ref = document.createElement('span');
      ref.className = 'ref';
      ref.textContent = ' @' + repo.ref;
      name.appendChild(ref);
    }
    name.title = slug + (repo.ref ? ' @ ' + repo.ref : '');
    row.appendChild(name);

    const lane = document.createElement('div');
    lane.className = 'bar-lane';

    if (counts.total === 0 && repo.total === 0) {
      const clean = document.createElement('span');
      clean.className = 'bar-zero';
      clean.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" ' +
        'fill="none" stroke="var(--good)" stroke-width="2.2" stroke-linecap="round" ' +
        'stroke-linejoin="round"><path d="M2.5 8.6 6.3 12.4 13.5 4.2"/></svg>';
      clean.append(document.createTextNode('no findings'));
      lane.appendChild(clean);
    } else if (counts.total === 0) {
      const none = document.createElement('span');
      none.className = 'bar-value';
      none.style.color = 'var(--text-muted)';
      none.textContent = 'none matching';
      lane.appendChild(none);
    } else {
      const track = document.createElement('div');
      track.className = 'bar-track';
      // 88% ではなく 100% まで使うと、末尾の数値ラベルが入らない。
      track.style.width = (counts.total / max * 88).toFixed(2) + '%';
      for (const sev of SEVERITIES) {
        if (!counts[sev]) continue;
        const seg = document.createElement('button');
        seg.type = 'button';
        seg.className = 'bar-seg';
        seg.dataset.sev = sev;
        seg.style.flex = String(counts[sev]);
        seg.style.background = SEV_VAR[sev];
        seg.setAttribute('aria-label',
          repo.name + ': ' + counts[sev] + ' ' + sev + ' of ' + counts.total);
        const describe = () => showTip(seg, repo.name,
          SEVERITIES.filter(s => counts[s]).map(s => ({
            color: SEV_VAR[s], value: fmt(counts[s]), label: s
          })));
        seg.addEventListener('pointerenter', describe);
        seg.addEventListener('focus', describe);
        seg.addEventListener('pointerleave', hideTip);
        seg.addEventListener('blur', hideTip);
        track.appendChild(seg);
      }
      lane.appendChild(track);
      const value = document.createElement('span');
      value.className = 'bar-value';
      value.textContent = fmt(counts.total);
      lane.appendChild(value);
    }
    row.appendChild(lane);
    repoBars.appendChild(row);
  }

  const shown = entries.reduce((sum, [, c]) => sum + c.total, 0);
  const top = entries[0];
  repoNote.textContent = top && shown > 0
    ? fmt(shown) + ' findings shown. ' + REPOS.get(top[0]).name + ' alone holds ' +
      Math.round(top[1].total / shown * 100) + '% of them.'
    : 'No findings match the current filters.';
}

/* ---------------- chart: most affected packages ---------------- */

const pkgBars = document.getElementById('pkg-bars');
const pkgNote = document.getElementById('pkg-axis-note');
const PKG_LIMIT = 12;

function renderPackageBars(rows) {
  const counts = new Map();
  for (const f of rows) {
    if (!f.package) continue;
    counts.set(f.package, (counts.get(f.package) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, PKG_LIMIT);
  const max = Math.max(1, ...shown.map(([, n]) => n));

  pkgBars.textContent = '';
  for (const [pkg, n] of shown) {
    const row = document.createElement('div');
    row.className = 'pkg-row';

    const head = document.createElement('div');
    head.className = 'pkg-head';
    const name = document.createElement('span');
    name.className = 'name mono';
    name.textContent = pkg;
    name.title = pkg;
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = fmt(n);
    head.append(name, num);

    const track = document.createElement('div');
    track.className = 'pkg-track';
    const fill = document.createElement('div');
    fill.className = 'pkg-fill';
    fill.style.width = (n / max * 100).toFixed(2) + '%';
    track.appendChild(fill);

    row.append(head, track);
    pkgBars.appendChild(row);
  }

  if (!ranked.length) {
    const empty = document.createElement('p');
    empty.className = 'axis-note';
    empty.style.borderTop = '0';
    empty.textContent = 'No packages match the current filters.';
    pkgBars.appendChild(empty);
    pkgNote.textContent = '';
    return;
  }
  pkgNote.textContent = ranked.length > PKG_LIMIT
    ? 'Top ' + PKG_LIMIT + ' of ' + fmt(ranked.length) +
      ' affected packages. Advisories per package, not per repository.'
    : fmt(ranked.length) + ' affected packages. Advisories per package, not per repository.';
}

/* ---------------- table ---------------- */

const body = document.getElementById('findings-body');
const tableCount = document.getElementById('table-count');
const ROW_LIMIT = 600;

function sortKey(f) {
  switch (state.sort) {
    case 'severity': return SEV_RANK[f.severity] * 100 + (f.cvss || 0);
    case 'cvss': return f.cvss === null ? -1 : f.cvss;
    case 'cve': return f.cve;
    case 'package': return f.package;
    case 'fixed': return f.fixed || '';
    case 'repo': return REPOS.get(f.repo).name;
    case 'target': return f.target;
    default: return 0;
  }
}

function renderTable(rows) {
  const sorted = rows.slice().sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    let cmp = typeof ka === 'string' ? ka.localeCompare(kb) : ka - kb;
    if (cmp === 0) cmp = SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      a.package.localeCompare(b.package) || a.cve.localeCompare(b.cve);
    else if (state.dir === 'desc') cmp = -cmp;
    return cmp;
  });

  body.textContent = '';
  if (!sorted.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty';
    td.textContent = 'No findings match the current filters.';
    tr.appendChild(td);
    body.appendChild(tr);
    tableCount.textContent = '';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const f of sorted.slice(0, ROW_LIMIT)) {
    const tr = document.createElement('tr');

    const sev = document.createElement('td');
    sev.className = 'nowrap';
    const badge = document.createElement('span');
    badge.className = 'sev-badge';
    badge.innerHTML = sevIcon(f.severity);
    badge.append(document.createTextNode(f.severity));
    sev.appendChild(badge);

    const cve = document.createElement('td');
    cve.className = 'mono nowrap';
    if (f.url) {
      const link = document.createElement('a');
      link.href = f.url;
      link.rel = 'noreferrer';
      link.textContent = f.cve;
      if (f.title) link.title = f.title;
      cve.appendChild(link);
    } else {
      cve.textContent = f.cve;
    }

    const cvss = document.createElement('td');
    cvss.className = 'num';
    cvss.textContent = f.cvss === null ? '\\u2014' : f.cvss.toFixed(1);

    const pkg = document.createElement('td');
    pkg.className = 'mono';
    pkg.textContent = f.package;

    const fix = document.createElement('td');
    fix.className = 'bump mono fix';
    if (f.fixed) {
      fix.append(document.createTextNode(f.installed + ' \\u2192 '));
      const to = document.createElement('b');
      to.textContent = f.fixed;
      fix.appendChild(to);
    } else {
      fix.append(document.createTextNode(f.installed + ' \\u2192 '));
      const none = document.createElement('span');
      none.className = 'pill';
      none.textContent = 'no fix yet';
      fix.appendChild(none);
    }

    const repo = document.createElement('td');
    repo.className = 'nowrap';
    const repoLink = document.createElement('a');
    repoLink.href = 'https://github.com/' + f.repo;
    repoLink.rel = 'noreferrer';
    repoLink.textContent = f.repo.split('/')[1];
    repo.appendChild(repoLink);

    const target = document.createElement('td');
    target.className = 'nowrap manifest';
    const file = document.createElement('span');
    file.className = 'mono';
    file.textContent = f.target;
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = f.ecosystem;
    target.append(file, pill);

    tr.append(sev, cve, cvss, pkg, fix, repo, target);
    frag.appendChild(tr);
  }
  body.appendChild(frag);

  tableCount.textContent = sorted.length > ROW_LIMIT
    ? 'Showing the first ' + fmt(ROW_LIMIT) + ' of ' + fmt(sorted.length) +
      ' matching findings. Narrow the filters to see the rest.'
    : fmt(sorted.length) + ' findings listed.';
}

/* ---------------- wiring ---------------- */

const filterCount = document.getElementById('filter-count');

function render() {
  const rows = SNAPSHOT.findings.filter(matches);
  filterCount.textContent = fmt(rows.length) + ' of ' +
    fmt(SNAPSHOT.findings.length) + ' findings';
  renderRepoBars(rows);
  renderPackageBars(rows);
  renderTable(rows);
  hideTip();
}

for (const chip of document.querySelectorAll('.chip[data-severity]')) {
  chip.addEventListener('click', () => {
    const sev = chip.dataset.severity;
    if (state.severities.has(sev)) {
      if (state.severities.size === 1) return;
      state.severities.delete(sev);
    } else {
      state.severities.add(sev);
    }
    chip.setAttribute('aria-pressed', String(state.severities.has(sev)));
    render();
  });
}

const repoSelect = document.getElementById('f-repo');
const ecoSelect = document.getElementById('f-eco');
const querySearch = document.getElementById('f-q');

repoSelect.addEventListener('change', () => { state.repo = repoSelect.value; render(); });
ecoSelect.addEventListener('change', () => { state.ecosystem = ecoSelect.value; render(); });
querySearch.addEventListener('input', () => { state.query = querySearch.value.trim(); render(); });

document.getElementById('reset-btn').addEventListener('click', () => {
  state.severities = new Set(SEVERITIES);
  state.repo = '';
  state.ecosystem = '';
  state.query = '';
  state.sort = 'severity';
  state.dir = 'desc';
  for (const chip of document.querySelectorAll('.chip[data-severity]')) {
    chip.setAttribute('aria-pressed', 'true');
  }
  repoSelect.value = '';
  ecoSelect.value = '';
  querySearch.value = '';
  markSort();
  render();
});

function markSort() {
  for (const th of document.querySelectorAll('#findings-table thead th')) {
    const arrow = th.querySelector('.arrow');
    const active = th.dataset.sort === state.sort;
    arrow.textContent = active ? (state.dir === 'desc' ? '\\u25BC' : '\\u25B2') : '';
    th.setAttribute('aria-sort', active
      ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none');
  }
}

for (const th of document.querySelectorAll('#findings-table thead th')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort === key) {
      state.dir = state.dir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sort = key;
      state.dir = key === 'cve' || key === 'package' || key === 'repo' ||
        key === 'target' || key === 'fixed' ? 'asc' : 'desc';
    }
    markSort();
    render();
  });
}

const themeBtn = document.getElementById('theme-btn');
themeBtn.addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  document.documentElement.dataset.theme = current === 'dark' ? 'light' : 'dark';
});

window.addEventListener('scroll', hideTip, { passive: true });
markSort();
render();
"""

# ページ上で使う色。palette.md の status パレットと categorical slot 1。
# status は severity（good -> critical の状態）に、slot 1 は単系列の棒に使う。
PALETTE = "#d03b3b,#ec835a,#fab219,#2a78d6"

SEV_SHAPE = {
    "CRITICAL": '<rect x="1.4" y="1.4" width="13.2" height="13.2" rx="2.4"/>',
    "HIGH": '<polygon points="8,1 15.4,14.4 0.6,14.4"/>',
    "MEDIUM": '<circle cx="8" cy="8" r="6.6"/>',
}
SEV_NOTE = {
    "CRITICAL": "the policy auto-remediates these",
    "HIGH": "reported, never auto-upgraded",
    "MEDIUM": "reported, never auto-upgraded",
}


def sev_icon(sev, size=13):
    return (
        f'<svg class="sev-icon" width="{size}" height="{size}" viewBox="0 0 16 16" '
        f'aria-hidden="true" fill="var(--sev-{sev.lower()})">{SEV_SHAPE[sev]}</svg>'
    )


def human_time(iso):
    """ISO8601 -> "2026-09-16 06:08 UTC"。空なら unknown。"""
    if not iso:
        return "unknown"
    text = iso.replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return iso
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def render(snapshot):
    repos = snapshot["repos"]
    findings = snapshot["findings"]
    owner = snapshot["owner"]
    total = len(findings)

    by_severity = {sev: sum(1 for f in findings if f["severity"] == sev) for sev in SEVERITIES}
    unique_cves = len({f["cve"] for f in findings})
    affected_packages = len({f["package"] for f in findings if f["package"]})
    fixable = sum(1 for f in findings if f["fixed"])
    clean_repos = sum(1 for r in repos if r["total"] == 0)
    critical_repos = sum(1 for r in repos if r["bySeverity"]["CRITICAL"] > 0)

    decisions = [d for r in repos for d in r["decisions"]]
    auto_remediated = sum(1 for d in decisions if d["action"] == "auto_remediate")
    deferred = sum(1 for d in decisions if d["action"] == "comment_only")
    already_open = sum(1 for d in decisions if d["outcome"] == "already_open")

    # 修正エージェントが開いた PR は cursor/ ブランチから来る。それ以外（Dependabot や
    # 人が開いたもの）は同じ一覧に混ぜず、件数だけ出す。
    agent_prs = [p for p in snapshot["openPullRequests"] if p["head"].startswith("cursor/")]
    other_prs = len(snapshot["openPullRequests"]) - len(agent_prs)

    severity_tiles = "\n".join(
        f"""    <div class="card tile">
      <span class="label">{sev_icon(sev)}{sev}</span>
      <span class="value">{by_severity[sev]:,}</span>
      <span class="sub">{by_severity[sev] * 100 // total if total else 0}% of findings &middot; {SEV_NOTE[sev]}</span>
    </div>"""
        for sev in SEVERITIES
    )

    severity_chips = "\n".join(
        f'    <button class="chip" type="button" data-severity="{sev}" aria-pressed="true">'
        f'<span class="tick" aria-hidden="true">&check;</span>{sev_icon(sev, 11)}{sev}</button>'
        for sev in SEVERITIES
    )

    severity_legend = "".join(
        f"<li>{sev_icon(sev)}{sev}</li>" for sev in SEVERITIES
    )

    repo_options = "".join(
        f'<option value="{html.escape(r["slug"], quote=True)}">'
        f'{html.escape(r["name"])}</option>'
        for r in sorted(repos, key=lambda r: -r["total"])
    )
    ecosystems = sorted({f["ecosystem"] for f in findings if f["ecosystem"]})
    eco_options = "".join(
        f'<option value="{html.escape(e, quote=True)}">{html.escape(e)}</option>'
        for e in ecosystems
    )

    if agent_prs:
        pr_items = "".join(
            f'<li><span class="pr-repo">{html.escape(p["repo"].split("/")[1])}</span>'
            f'<span class="pr-title"><a href="{html.escape(p["url"], quote=True)}" rel="noreferrer">'
            f'{html.escape(p["title"])}</a></span>'
            f'<span class="pr-num">#{p["number"]}</span></li>'
            for p in sorted(agent_prs, key=lambda p: (p["repo"], -p["number"]))
        )
    else:
        pr_items = '<li><span class="pr-title">No remediation requests are open.</span></li>'

    pr_subhead = (
        f"{len(agent_prs)} request"
        f"{'' if len(agent_prs) == 1 else 's'} opened by the remediation agent and still "
        f"awaiting review. Read live from GitHub when this page was built"
    )
    pr_subhead += (
        f"; {other_prs} further open pull request{'' if other_prs == 1 else 's'} "
        f"in these repositories came from elsewhere and are not listed."
        if other_prs
        else "."
    )

    decided_packages = len({d["package"] for d in decisions if d["package"]})
    coverage_note = (
        f"Policy decisions in this run cover {decided_packages} of the "
        f"{affected_packages} affected packages. Repositories with very large "
        f"dependency trees are triaged over several runs, so the four counts below "
        f"are the work this run got to \u2014 not a verdict on every finding above."
    )

    title = "Fleet vulnerability report"
    runs_url = (
        f"https://github.com/{owner}/cursor-governance-demo/actions/workflows/"
        "fleet-governance.yml"
    )

    from string import Template

    page = Template(TEMPLATE).substitute(
        palette=PALETTE,
        title=title,
        description=(
            f"{total} open dependency vulnerabilities across {len(repos)} repositories "
            f"owned by {owner}, as of {human_time(snapshot['scannedAt'])}."
        ),
        owner=html.escape(owner),
        scanned_human=human_time(snapshot["scannedAt"]),
        generated_human=human_time(snapshot["generatedAt"]),
        scanner_name=html.escape(snapshot["scanner"]),
        run_url=html.escape(snapshot["runUrl"] or runs_url, quote=True),
        runs_url=runs_url,
        total_findings=f"{total:,}",
        unique_cves=f"{unique_cves:,}",
        affected_packages=f"{affected_packages:,}",
        severity_tiles=severity_tiles,
        repo_count=len(repos),
        clean_repos=clean_repos,
        agent_prs=len(agent_prs),
        fixable=f"{fixable:,}",
        fixable_pct=fixable * 100 // total if total else 0,
        severity_chips=severity_chips,
        severity_legend=severity_legend,
        repo_options=repo_options,
        eco_options=eco_options,
        auto_remediated=auto_remediated,
        deferred=deferred,
        already_open=already_open,
        critical_repos=critical_repos,
        coverage_note=coverage_note,
        pr_subhead=pr_subhead,
        pr_items=pr_items,
        data_json=json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).replace(
            "</", "<\\/"
        ),
        script=SCRIPT,
    )
    return page


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / "index.html"
    target.write_text(render(snapshot))
    size = target.stat().st_size
    print(f"{target} ({size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
