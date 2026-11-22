#!/usr/bin/env node
/**
 * Ask the feature map which screen a phrase means.
 *
 *   node scripts/feature-map.mjs list [--json]
 *   node scripts/feature-map.mjs find <words...> [--json]
 *   node scripts/feature-map.mjs show <surface id> [--json]
 *
 * `find` ranks surfaces by id, UI label, navigation place, alias, route,
 * component file and purpose. It exits 1 when no id, label, alias or route
 * word matches exactly, when a query word matches no surface, or when another
 * surface scores close to the best one.
 * Aliases (words people use that the code does not) live in
 * `scripts/feature-map-aliases.json`; everything else comes from source. See
 * `scripts/lib/feature-map.mjs`.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildFeatureMap,
  describePlace,
  rankSurfaces,
} from "./lib/feature-map.mjs";

const USAGE =
  "usage: feature-map.mjs list | find <words...> | show <surface id> [--json] [--root <inspector dir>]";
const TOP = 5;

const placesText = (entry) =>
  entry.places.length
    ? entry.places.map(describePlace).join("; ")
    : "not in the sidebar or Connect tabs";

const list = (label, files) =>
  files.length
    ? [`  ${label}:`, ...files.map((f) => `    ${f}`)]
    : [`  ${label}: none`];

function formatEntry(entry, { full }) {
  const lines = [
    `${entry.id}  "${entry.label}"`,
    `  where: ${placesText(entry)}`,
    `  route: ${entry.route}  (nav: ${entry.navSegments.join(", ")})`,
    `  renders: ${entry.roots.join(", ") || "none found"}`,
  ];
  if (full) {
    lines.push(
      `  title: ${entry.title}  scope: ${entry.scope}  in agent atlas: ${entry.inAtlas}`,
      `  purpose: ${entry.purpose}`,
      ...list("does", entry.userActivities),
      `  routes: ${entry.routePatterns.join(", ")}`,
      `  aliases: ${entry.aliases.join(", ") || "none"}`,
      ...list("children (one import down)", entry.children),
    );
  }
  lines.push(...list("e2e", entry.e2e));
  // Evaluate alone has hundreds; `list` stays readable and `show` has them all.
  if (full) lines.push(...list("component tests", entry.component));
  else
    lines.push(
      `  component tests: ${entry.component.length} (feature-map show ${entry.id})`,
    );
  return lines.join("\n");
}

function formatFind(result, map) {
  const byId = new Map(map.map((e) => [e.id, e]));
  const lines = [`query words: ${result.query.join(" ") || "(none)"}`];
  if (result.unmatched.length)
    lines.push(`no surface mentions: ${result.unmatched.join(", ")}`);
  if (!result.confident) {
    const why = result.unmatched.length
      ? "a query word matches no surface"
      : result.ambiguous.length
        ? `${result.ranked[0].id} scores too close to ${result.ambiguous.join(", ")}`
        : "no id, label, alias or route word matched exactly, and no one phrase of a surface other than a file name held two query words";
    lines.push(`no confident match: ${why}`);
    if (result.ranked.length) lines.push("closest:");
  }
  for (const [i, r] of result.ranked.slice(0, TOP).entries()) {
    const entry = byId.get(r.id);
    lines.push(
      `${i + 1}. ${r.id}  "${r.label}"  score ${r.score.toFixed(1)}`,
      `   where: ${placesText(entry)}`,
      `   route: ${entry.route}`,
      `   renders: ${entry.roots.join(", ") || "none found"}`,
      `   why: ${r.reasons.join("; ")}`,
    );
  }
  return lines.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const rootIndex = argv.indexOf("--root");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(
    rootIndex === -1 ? join(scriptDir, "..") : argv[rootIndex + 1],
  );
  const args = argv.filter(
    (a, i) =>
      a !== "--json" &&
      (rootIndex === -1 || (i !== rootIndex && i !== rootIndex + 1)),
  );
  const [command, ...rest] = args;
  const out = (value, text) =>
    console.log(json ? JSON.stringify(value, null, 2) : text);

  if (command === "list" && rest.length === 0) {
    const map = buildFeatureMap(root);
    out(map, map.map((e) => formatEntry(e, { full: false })).join("\n\n"));
    return 0;
  }
  if (command === "find" && rest.length > 0) {
    const map = buildFeatureMap(root);
    const result = rankSurfaces(map, rest.join(" "));
    out(
      { ...result, ranked: result.ranked.slice(0, TOP) },
      formatFind(result, map),
    );
    return result.confident ? 0 : 1;
  }
  if (command === "show" && rest.length === 1) {
    const map = buildFeatureMap(root);
    const entry = map.find((e) => e.id === rest[0]);
    if (!entry) {
      console.error(
        `no surface "${rest[0]}". Ids: ${map.map((e) => e.id).join(", ")}`,
      );
      return 1;
    }
    out(entry, formatEntry(entry, { full: true }));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
