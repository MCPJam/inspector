#!/usr/bin/env node
// Renders `npm audit --json` output as a GitHub step summary table.
//
// Runs after the audit gate, including when the gate has already failed, so the
// summary has to survive whatever it is handed: `npm audit` exits non-zero when
// it finds anything, and on a registry error it writes a JSON error payload with
// no `metadata` at all. A crash here would fail the job on top of whatever the
// gate already reported, so unreadable input degrades to a dash rather than
// throwing.

import { readFileSync } from "node:fs";

const SEVERITIES = ["critical", "high", "moderate", "low"];

function counts(path) {
  try {
    const vulns = JSON.parse(readFileSync(path, "utf8")).metadata?.vulnerabilities;
    if (!vulns) return null;
    return SEVERITIES.map((severity) => vulns[severity] ?? 0);
  } catch {
    return null;
  }
}

function row(label, path) {
  const cells = counts(path) ?? SEVERITIES.map(() => "—");
  return `| ${label} | ${cells.join(" | ")} |`;
}

const [prodPath, allPath] = process.argv.slice(2);

console.log(`### Dependency advisories

| Scope | Critical | High | Moderate | Low |
| --- | --- | --- | --- | --- |
${row("Production", prodPath)}
${row("Including dev", allPath)}

The build fails on a **critical** advisory in production dependencies.
Dev-only advisories are reported here but do not fail the build.`);
