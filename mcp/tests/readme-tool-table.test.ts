import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_CATALOG_OPERATIONS,
  PLATFORM_TOOL_WIDGET_VIEWS,
} from "../src/tools/platformTools.js";

/**
 * The README's tool table IS the catalog.
 *
 * It had drifted to 17 rows while the catalog carried 43 — a README that
 * confidently lists two fifths of the tools is worse than one that lists none,
 * because a reader has no way to tell which two fifths.
 *
 * PINNED BY A TEST, NOT EMITTED BY A GENERATOR. A generator makes the file
 * untouchable and its output unreviewed: nobody edits generated prose, so the
 * descriptions never improve, and a bad one ships forever. A test lets a human
 * write the row and fails the moment the row stops being true — which is the
 * property that was missing, not the typing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, "..", "README.md"), "utf8");

/** `| \`name\` | description | widget |` rows, in document order. */
/**
 * ONE parser for the table. The description check used to re-parse the README a
 * second way — `split("\n")` plus `startsWith("| \`name\`")` — and the two made
 * different spacing assumptions about the same rows: the regex tolerates
 * `|\`name\`|` with no space after the pipe, the `startsWith` required exactly
 * one. An edit removing that space would leave the regex matching and the
 * lookup returning `undefined`, failing the description check for a reason that
 * has nothing to do with descriptions. The description is captured here.
 */
function tableRows(): Array<{
  name: string;
  description: string;
  widget: string;
}> {
  const rows: Array<{ name: string; description: string; widget: string }> = [];
  for (const match of readme.matchAll(
    /^\|\s*`([a-z0-9_]+)`\s*\|([^|]*)\|\s*(\S+)\s*\|\s*$/gm
  )) {
    rows.push({
      name: match[1]!,
      description: match[2]!.trim(),
      widget: match[3]!.trim(),
    });
  }
  return rows;
}

describe("README tool table", () => {
  const rows = tableRows();
  const documented = rows.map((row) => row.name);
  const catalog = PLATFORM_CATALOG_OPERATIONS.map(
    (operation) => operation.name
  );

  it("parses rows at all — a broken regex would pass everything else", () => {
    expect(rows.length).toBeGreaterThan(10);
  });

  it("documents every catalog tool", () => {
    const missing = catalog.filter((name) => !documented.includes(name)).sort();
    expect(
      missing,
      `Tools in PLATFORM_CATALOG_OPERATIONS with no README row — add one:\n  ${missing.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("documents no tool that is not in the catalog", () => {
    const phantom = documented.filter((name) => !catalog.includes(name)).sort();
    expect(
      phantom,
      `README rows for tools the worker does not register (renamed? excluded?):\n  ${phantom.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("lists them in catalog order", () => {
    // Order is how a reader finds a tool. Matching it to the registration
    // order also means a tool added in the middle cannot be appended at the
    // bottom and quietly lose its grouping.
    expect(documented).toEqual(catalog);
  });

  it("marks the widget column correctly", () => {
    const wrong = rows
      .filter((row) => {
        const hasWidget = Boolean(PLATFORM_TOOL_WIDGET_VIEWS[row.name]);
        return hasWidget !== (row.widget === "✅");
      })
      .map((row) => row.name)
      .sort();
    expect(
      wrong,
      `Rows whose Widget column disagrees with PLATFORM_TOOL_WIDGET_VIEWS:\n  ${wrong.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("gives every row a description", () => {
    const empty = rows
      .filter((row) => row.description.length < 10)
      .map((row) => row.name);
    expect(
      empty,
      `Rows with no real description:\n  ${empty.join("\n  ")}`
    ).toEqual([]);
  });
});
