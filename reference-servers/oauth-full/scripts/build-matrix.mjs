// Merge captures/*.json into RESULTS.md — the HP-10 client × OAuth-feature matrix.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const capturesDir = process.argv[2] ?? join(here, "..", "captures");
const outFile = process.argv[3] ?? join(here, "..", "RESULTS.md");

// Canonical HP-10 client order; captures with other labels are appended.
const CLIENT_ORDER = [
  "mcpjam", "claude", "chatgpt", "mistral", "goose",
  "slack", "cursor", "codex", "copilot", "vscode",
];

if (!existsSync(capturesDir)) {
  console.error(`No captures directory at ${capturesDir}. Run the reference server first.`);
  process.exit(1);
}

const reports = readdirSync(capturesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(capturesDir, f), "utf8")));

reports.sort((a, b) => {
  const ia = CLIENT_ORDER.indexOf(a.label);
  const ib = CLIENT_ORDER.indexOf(b.label);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.label.localeCompare(b.label);
});

const yn = (v) => (v === true ? "✅" : v === false ? "❌" : "—");

const FEATURES = [
  ["Completed flow", (r) => yn(r.traits.completedFlow)],
  ["PRM discovery (RFC 9728)", (r) => yn(r.traits.discovery.fetchedProtectedResourceMetadata)],
  ["AS metadata format", (r) => r.traits.discovery.asMetadataFormat],
  ["Registration", (r) => r.traits.registration.strategy],
  ["DCR client_name", (r) => r.traits.registration.dcrIdentity?.clientName ?? "—"],
  ["PKCE", (r) => (r.traits.authorization.usedPkce ? r.traits.authorization.pkceMethod ?? "yes" : "❌")],
  ["state param", (r) => yn(r.traits.authorization.sentState)],
  ["resource param (authorize)", (r) => yn(r.traits.authorization.sendsResourceParamAuthorize)],
  ["resource param (token)", (r) => yn(r.traits.token.sendsResourceParamToken)],
  ["Scope policy", (r) => r.traits.authorization.scopeRequestPolicy],
  ["Redirect URI kind", (r) => r.traits.authorization.redirectUriKind],
  ["Token endpoint auth", (r) => r.traits.token.tokenEndpointAuthMethod],
  ["Refresh works", (r) => (r.traits.token.refreshAttempted ? yn(r.traits.token.refreshSucceeded) : "not attempted")],
  ["XAA / ID-JAG", (r) => yn(r.traits.token.usedJwtBearerIdJag)],
  ["Exercised tools", (r) => yn(r.traits.capabilityExercise.calledTools)],
  ["Exercised resources", (r) => yn(r.traits.capabilityExercise.calledResources)],
  ["Exercised prompts", (r) => yn(r.traits.capabilityExercise.calledPrompts)],
  ["Elicitation answered", (r) => yn(r.traits.capabilityExercise.respondedToElicitation)],
];

const lines = [];
lines.push("# HP-10 results matrix — client × OAuth feature");
lines.push("");
lines.push(`Generated ${new Date().toISOString()} from ${reports.length} capture(s) in \`${capturesDir}\`.`);
lines.push("");
lines.push(`| Feature | ${reports.map((r) => `**${r.label}**`).join(" | ")} |`);
lines.push(`|---|${reports.map(() => "---").join("|")}|`);
for (const [name, get] of FEATURES) {
  lines.push(`| ${name} | ${reports.map((r) => String(get(r))).join(" | ")} |`);
}
lines.push("");
lines.push("## Failure categories per client");
lines.push("");
for (const r of reports) {
  lines.push(`### ${r.label}`);
  lines.push("");
  if (r.traits.failures.length === 0) {
    lines.push("- none observed");
  } else {
    for (const f of r.traits.failures) lines.push(`- ${f}`);
  }
  lines.push("");
}
lines.push("## Derived oauthProfile (HP-1 `HostConfigOAuthProfileV1`) per client");
lines.push("");
lines.push("Paste-ready values for the host catalog seed / backend `oauthProfile` once HP-1's PRs land.");
lines.push("");
for (const r of reports) {
  lines.push(`### ${r.label}`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(r.oauthProfile, null, 2));
  lines.push("```");
  lines.push("");
}

const missing = CLIENT_ORDER.filter((c) => !reports.some((r) => r.label === c));
if (missing.length) {
  lines.push(`> Still missing captures for: ${missing.join(", ")}`);
  lines.push("");
}

writeFileSync(outFile, lines.join("\n"));
console.log(`Wrote ${outFile} (${reports.length} clients, ${missing.length} missing)`);
