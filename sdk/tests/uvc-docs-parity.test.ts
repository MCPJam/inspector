/**
 * THE DOCS' STAGE COLUMN IS THE CONTRACT'S, OR IT IS WRONG.
 *
 * Two published tables tell an author which link of the user-value chain each
 * check measures. Both are hand-written prose, and the map they claim to
 * reflect — `PREDICATE_STAGE` — is derived from the predicate union itself.
 * So the failure mode is silent and one-directional: someone adds a kind, the
 * union grows, the contract grows with it, and the tables do not. The kind
 * then exists, is authorable, files at a stage, and is documented nowhere.
 *
 * That already happened. `onlyToolsCalled` shipped and neither table gained a
 * row, so both listed 26 kinds against a union of 27 until this test was
 * written.
 *
 * Three claims, each of which would otherwise rot:
 *
 *  1. **Every kind is documented.** A new predicate fails here until its row
 *     exists in both tables.
 *  2. **No table invents a kind.** A renamed or removed kind fails here rather
 *     than lingering as a row nobody can author.
 *  3. **Every documented stage matches the contract.** Moving a kind between
 *     links is a versioned analyzer change; this makes the docs part of that
 *     change rather than a thing discovered later.
 *
 * Deliberately parses the shipped `.mdx` rather than generating it. These are
 * prose tables with per-kind descriptions that a generator would flatten, and
 * the thing worth pinning is the column, not the sentence beside it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PREDICATE_KINDS,
  PREDICATE_STAGE,
} from "../src/contract/grader-stage.js";
import { USER_VALUE_STAGE_LABELS } from "../src/contract/decision-labels.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

/** The published tables that carry a `Measures` column. */
const DOC_TABLES = [
  "docs/sdk/reference/eval-reporting.mdx",
  "docs/sdk/concepts/running-evals.mdx",
] as const;

/** `| \`kind\` | … |` → the cells, trimmed. */
function rowCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Read the one table whose header carries a `Measures` column.
 *
 * Located by its header rather than by line number, so moving the table down
 * the page does not quietly stop this test from checking anything, and the
 * `Measures` cell is read by header position rather than by index so a column
 * inserted before it does not shift the assertion onto prose.
 *
 * The kind itself is read from the FIRST cell, which both tables use. A row
 * whose first cell is not a single backticked identifier is skipped — that is
 * what lets the separator row and any prose row pass through harmlessly, and
 * it is why a kind moved out of column one would read as missing rather than
 * as passing.
 */
function readMeasuresTable(relativePath: string): Map<string, string> {
  const lines = readFileSync(path.join(REPO_ROOT, relativePath), "utf8").split(
    "\n"
  );

  const headerIndex = lines.findIndex(
    (line) =>
      line.trimStart().startsWith("|") &&
      rowCells(line).some((cell) => cell === "Measures")
  );
  expect(
    headerIndex,
    `${relativePath} has no table with a "Measures" column. The stage column is ` +
      `how an author learns which link a check measures; if it moved, point ` +
      `this test at its new home rather than deleting the column.`
  ).toBeGreaterThan(-1);

  const header = rowCells(lines[headerIndex]);
  const measuresColumn = header.indexOf("Measures");

  const found = new Map<string, string>();
  // Skip the header and its `|---|` separator.
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trimStart().startsWith("|")) break;
    const cells = rowCells(line);
    const kindMatch = /^`([A-Za-z][A-Za-z0-9]*)`$/.exec(cells[0] ?? "");
    if (!kindMatch) continue;
    found.set(kindMatch[1], cells[measuresColumn] ?? "");
  }
  return found;
}

describe.each(DOC_TABLES)("%s documents every check's stage", (docPath) => {
  const documented = readMeasuresTable(docPath);

  it("lists every predicate kind the schema admits", () => {
    const missing = [...PREDICATE_KINDS].filter(
      (kind) => !documented.has(kind)
    );
    expect(
      missing,
      `Undocumented predicate kind(s). They are authorable and file at a chain ` +
        `link, so an author can write one and never be told what it measures. ` +
        `Add a row to ${docPath} with its Measures column.`
    ).toEqual([]);
  });

  it("invents no kind that the schema does not admit", () => {
    const unknown = [...documented.keys()].filter(
      (kind) => !(PREDICATE_KINDS as readonly string[]).includes(kind)
    );
    expect(
      unknown,
      `${docPath} documents kind(s) that no longer exist. A reader who ` +
        `authors one gets "unknown predicate type" on every trial.`
    ).toEqual([]);
  });

  it("agrees with PREDICATE_STAGE on every kind", () => {
    const disagreements = [...documented.entries()]
      .filter(([kind]) => (PREDICATE_KINDS as readonly string[]).includes(kind))
      .map(([kind, documentedStage]) => ({
        kind,
        documented: documentedStage,
        contract:
          USER_VALUE_STAGE_LABELS[
            PREDICATE_STAGE[kind as keyof typeof PREDICATE_STAGE]
          ],
      }))
      .filter((row) => row.documented !== row.contract);

    expect(
      disagreements,
      `${docPath} disagrees with PREDICATE_STAGE. Moving a kind between links ` +
        `re-attributes historical failures and is a versioned analyzer change; ` +
        `the docs move with it, not after it.`
    ).toEqual([]);
  });
});

describe("the chain's unauthorable links", () => {
  it("keeps connection and discovery free of authored checks", () => {
    const authorable = [...PREDICATE_KINDS].filter((kind) =>
      ["connection", "discovery"].includes(PREDICATE_STAGE[kind])
    );
    expect(
      authorable,
      `A predicate now files at connection or discovery. Both docs state ` +
        `plainly that no check can reach those links — the runner decides them ` +
        `from setup signals and the egress canary before the case runs. Update ` +
        `that claim in docs/sdk/concepts/user-value-chain.mdx before shipping.`
    ).toEqual([]);
  });
});
