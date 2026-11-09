#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW = ".agents/skills/error-message-review/SKILL.md";

export function errorsSection(design) {
  return design.match(/(?:^|\n)## Errors\r?\n([\s\S]*?)(?=\n## |$)/)?.[1];
}

export function checkErrorRules(design, skill, rubric) {
  const errors = [];
  const section = errorsSection(design);
  if (section === undefined) errors.push('DESIGN.md has no "## Errors" section.');
  const headings = [...(section ?? "").matchAll(/\*\*(E\d+) —/g)].map(m => m[1]);
  const defined = new Set(headings);
  if (!defined.size) errors.push("DESIGN.md defines no E-rules.");
  if (headings.length !== defined.size) errors.push("DESIGN.md has duplicate E-rule definitions.");
  const order = skill.match(/(?:^|\n)## Order of decision\r?\n([\s\S]*?)(?=\n## |$)/)?.[1];
  if (order === undefined) errors.push(`${REVIEW} has no decision order.`);
  const cited = new Set([...skill.matchAll(/\b(E\d+)\b/g)].map(m => m[1]));
  const applied = new Set([...(order ?? "").matchAll(/\b(E\d+)\b/g)].map(m => m[1]));
  for (const id of cited) {
    if (!defined.has(id)) errors.push(`${REVIEW} cites undefined ${id}.`);
  }
  for (const id of defined) {
    if (!applied.has(id)) errors.push(`${REVIEW}'s decision order does not apply ${id}.`);
  }
  if (!skill.includes("DESIGN.md")) errors.push(`${REVIEW} must reference DESIGN.md.`);
  if (!rubric.includes("DESIGN.md") || !rubric.includes(REVIEW)) {
    errors.push("ui-copy must reference the canonical standard and error reviewer.");
  }
  return errors;
}

export function main() {
  const read = path => readFileSync(resolve(ROOT, path), "utf8");
  const errors = checkErrorRules(read("DESIGN.md"), read(REVIEW), read(".agents/skills/ui-copy/SKILL.md"));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Error rules are defined, applied, and linked to the copy reviewer.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
