/**
 * The decision scan's candidate rules on MCPJam's own catalog, at the commits
 * on either side of the fix that took cross-tool directions out of its
 * descriptions after Claude's directory flagged them. No model: these are the
 * numbers the rules give, so a rule change shows up as a change here. The
 * field study counted 248 operations, 78 descriptions naming another tool
 * before and 50 after, and 28 of 32 changed descriptions caught by a phrase
 * list written after reading the fix; the counts below are this catalog's,
 * and the comments say where they differ.
 */

import { describe, expect, it } from "vitest";

import {
  loadMcpjamCatalogs,
  type CatalogTool,
} from "../../scripts/generate-decision-scan-catalogs.js";
import {
  findDecisionCandidates,
  selectDecisionItems,
} from "../../src/directory-readiness/index.js";

const DIRECTION = "claude.decision.cross-tool-direction";
const SECRETS = "openai.decision.secret-seeking";

const { source, before, after } = loadMcpjamCatalogs();
const listed = (tools: readonly CatalogTool[]) =>
  tools.filter((tool) => tool.listed);

/** Every string in a tool, by its path, as a candidate names its field. */
function texts(value: unknown, at = ""): Array<[string, string]> {
  if (typeof value === "string") return [[at, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    texts(child, at ? `${at}.${key}` : key)
  );
}

/** What the fix changed: each string that differs, as `tool field`. */
const changes = before.flatMap((tool, index) => {
  const later = new Map(texts(after[index]));
  return texts(tool)
    .filter(([field, text]) => later.get(field) !== text)
    .map(([field]) => ({ tool: tool.name, field }));
});

const TOKEN = /[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?/g;

/** Tools whose own description names another operation of the catalog. */
function namingAnother(tools: readonly CatalogTool[]): number {
  const names = new Set(tools.map(({ name }) => name));
  return tools.filter(({ name, description }) =>
    [...description.matchAll(TOKEN)].some(
      ([token]) => token !== name && names.has(token)
    )
  ).length;
}

function directions(tools: readonly CatalogTool[]) {
  return findDecisionCandidates("claude", { tools }).filter(
    (item) => item.questionId === DIRECTION
  );
}

const fieldsOf = (items: ReturnType<typeof directions>) =>
  new Set(items.map(({ candidate }) => `${candidate.tool} ${candidate.field}`));

/** The strings the fix changed that the rules do not propose before it. */
function uncaught(tools: readonly CatalogTool[]): string[] {
  const proposed = fieldsOf(directions(tools));
  const names = new Set(tools.map(({ name }) => name));
  return changes
    .filter((change) => names.has(change.tool))
    .map(({ tool, field }) => `${tool} ${field}`)
    .filter((field) => !proposed.has(field));
}

describe("the fixture", () => {
  it("holds the commits on either side of the fix, which changed only text", () => {
    expect(source.before).toBe("9943ecab8336e83cbc9c341e39ff9d9142c43a7c");
    expect(source.after).toBe("0eafeedada13af1ac4d7654e402032f30903254f");
    expect(before).toHaveLength(249);
    expect(listed(before)).toHaveLength(205);
    // The same tools with the same fields: only the text changed.
    const shape = (tools: readonly CatalogTool[]) =>
      tools.map((tool) => texts(tool).map(([field]) => field));
    expect(shape(after)).toEqual(shape(before));
    expect(changes).toHaveLength(36);
    expect(new Set(changes.map(({ tool }) => tool)).size).toBe(36);
  });
});

describe("the listed catalog, as MCP, the CLI and the agent registry list it", () => {
  it("names another operation in 63 descriptions before the fix and 36 after", () => {
    expect(namingAnother(listed(before))).toBe(63);
    expect(namingAnother(listed(after))).toBe(36);
  });

  it("proposes 29 directions in 26 fields before the fix, more than one run may ask, and 1 after", () => {
    const proposed = directions(listed(before));
    expect(proposed).toHaveLength(29);
    expect(fieldsOf(proposed).size).toBe(26);
    // The per-run cap leaves 5 unasked, so this question is not evaluated.
    const selection = selectDecisionItems("claude", proposed);
    expect(selection.unasked).toEqual({ [DIRECTION]: 5 });

    // A direction the fix left: "pass that to get_plugin_version".
    expect([...fieldsOf(directions(listed(after)))]).toEqual([
      "list_project_plugins description",
    ]);
  });

  it("proposes 25 of the 32 strings the fix changed", () => {
    // Four name no other tool: two parameters ("see the images operations",
    // "promote a personal draft first"), "Call it before sending a model
    // override", and "--compose-skill". Three are directions the verb lists
    // miss:
    // "Get the prompt name and argument list from list_server_prompts
    // first", "Pass a revisionNumber back as expectedRevisionNumber on
    // update_eval_suite", "Use this to discover the organization id that
    // list_projects filters by".
    expect(uncaught(listed(before))).toEqual([
      "list_organizations description",
      "get_server_prompt description",
      "list_eval_suite_revisions description",
      "get_project_environment_capabilities description",
      "create_project_environment inputSchema.properties.sandboxImageId.description",
      "ensure_adhoc_environment inputSchema.properties.computer.description",
      "list_project_skills description",
    ]);
  });

  it("sends 67 secret-seeking candidates from the fixed catalog, 45 more than one run may ask", () => {
    // MCPJam's own tools manage secrets and tokens; the rules propose every
    // sentence that names one, so on a catalog like this the cap, not the
    // model, decides whether the question is answered.
    const proposed = findDecisionCandidates("openai", {
      tools: listed(after),
    });
    expect(proposed.filter((item) => item.questionId === SECRETS)).toHaveLength(
      67
    );
    expect(selectDecisionItems("openai", proposed).unasked).toEqual({
      [SECRETS]: 45,
    });
  });
});

describe("every exported operation, as the field study counted them", () => {
  // 249, not 248, and 80, not 78: the study's own script was not kept. The
  // 44 unlisted operations are old names no surface lists, whose
  // "Deprecated: use create_client." the rules propose as directions.
  it("names another operation in 80 descriptions before the fix and 50 after", () => {
    expect(namingAnother(before)).toBe(80);
    expect(namingAnother(after)).toBe(50);
  });

  it("proposes 43 directions before the fix and 12 after, 11 of them on old names", () => {
    expect(directions(before)).toHaveLength(43);
    const remaining = directions(after);
    expect(remaining).toHaveLength(12);
    const aliases = new Set(
      after.filter((tool) => !tool.listed).map(({ name }) => name)
    );
    expect(
      remaining.filter(({ candidate }) => aliases.has(candidate.tool ?? ""))
    ).toHaveLength(11);
  });

  it("proposes 28 of the 36 strings the fix changed", () => {
    expect(uncaught(before)).toHaveLength(8);
    expect(uncaught(before)).toContain("get_user_testing_signals description");
  });
});
