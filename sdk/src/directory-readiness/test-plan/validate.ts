/**
 * A plan checked against the tools the server lists now, after a person or an
 * agent edited it.
 *
 * `limit` issues mean the plan cannot be stored. Any other issue leaves a
 * plan that is still being edited storable, and any issue keeps it from being
 * authorized: the consent covers exactly the calls the plan names, so it must
 * name every tool, and each call must be safe to make.
 *
 * Pure. Safe from the browser entry.
 */

import { canonicalJson } from "../../contract/canonical.js";
import { directoryToolEffect } from "./draft.js";
import { directoryFixtureReferences } from "./fixtures.js";
import {
  DIRECTORY_TEST_PLAN_LIMITS as LIMITS,
  DIRECTORY_TOOL_EFFECTS,
} from "./types.js";
import type {
  DirectoryTestFixture,
  DirectoryTestPlan,
  DirectoryTestPlanIssue,
  DirectoryTestPlanTool,
  DirectoryToolPlan,
} from "./types.js";
import { issueWords, type IssueWording } from "./wording.js";

type About = Pick<DirectoryTestPlanIssue, "tool" | "caseId" | "fixture">;
type Vars = Record<string, string | number>;

interface Context {
  plan: DirectoryTestPlan;
  listed: ReadonlyMap<string, DirectoryTestPlanTool>;
  /** The first entry for each id, kept by the checks that run first. */
  entries: Map<string, DirectoryToolPlan>;
  fixtures: Map<string, DirectoryTestFixture>;
  add(words: IssueWording, about?: About, vars?: Vars): void;
}

export function validateDirectoryTestPlan(
  plan: DirectoryTestPlan,
  tools: readonly DirectoryTestPlanTool[]
): DirectoryTestPlanIssue[] {
  const issues: DirectoryTestPlanIssue[] = [];
  const context: Context = {
    plan,
    listed: new Map(tools.map((tool) => [tool.name, tool])),
    entries: new Map(),
    fixtures: new Map(),
    add(words, about = {}, vars = {}) {
      issues.push({ ...issueWords(words, { ...about, ...vars }), ...about });
    },
  };
  // In this order: later checks read the fixtures and entries earlier ones keep.
  checkFixtures(context);
  checkTools(context);
  checkCases(context);
  checkOrder(context);
  checkCleanup(context);
  checkLimits(context);
  return issues;
}

function checkFixtures({ plan, fixtures, add }: Context) {
  for (const fixture of plan.fixtures) {
    if (fixtures.has(fixture.id))
      add("duplicate.fixture", { fixture: fixture.id });
    else fixtures.set(fixture.id, fixture);
  }
  for (const { id, origin } of fixtures.values()) {
    const by = plan.cases.filter((testCase) => testCase.creates?.includes(id));
    const about = { fixture: id, ...(by[0] ? { caseId: by[0].id } : {}) };
    if (origin === "existing" && by.length > 0)
      add("fixtureCreation.existing", about);
    if (origin === "created" && by.length === 0)
      add("fixtureCreation.none", about);
    if (origin === "created" && by.length > 1)
      add("fixtureCreation.twice", about);
  }
}

function checkTools({ plan, listed, entries, fixtures, add }: Context) {
  const rank = (effect: string) =>
    DIRECTORY_TOOL_EFFECTS.findIndex((known) => known === effect);
  for (const entry of plan.tools) {
    const about = { tool: entry.tool };
    if (entries.has(entry.tool)) {
      add("duplicate.tool", about);
      continue;
    }
    entries.set(entry.tool, entry);
    const tool = listed.get(entry.tool);
    const declared = tool && directoryToolEffect(tool).effect;
    if (!declared) add("unknownTool", about);
    else if (rank(entry.effect) < rank(declared)) {
      add("lessCautious", about, { declared, planned: entry.effect });
    }
    const { exclusion } = entry;
    if (entry.action === "excluded") {
      if (!exclusion) add("exclusion.reason", about);
      else if (exclusion.reason === "other" && !exclusion.note?.trim()) {
        add("exclusion.note", about);
      }
    } else if (entry.effect !== "read" && entry.writes.length === 0) {
      add("writeScope.missing", about);
    }
    for (const fixture of entry.writes.filter((id) => !fixtures.has(id))) {
      add("unknownFixture", { ...about, fixture }, { where: entry.tool });
    }
  }
  for (const tool of listed.keys()) {
    if (!entries.has(tool)) add("missingTool", { tool });
  }
}

function checkCases(context: Context) {
  const { plan, entries, fixtures, add } = context;
  const ids = new Set<string>();
  const kinds = new Map<string, Set<string>>();
  for (const testCase of plan.cases) {
    const about = { tool: testCase.tool, caseId: testCase.id };
    if (ids.has(testCase.id)) add("duplicate.case", about);
    ids.add(testCase.id);
    const entry = entries.get(testCase.tool);
    if (!entry) {
      add("unknownTool.case", about);
      continue;
    }
    kinds.set(
      entry.tool,
      (kinds.get(entry.tool) ?? new Set()).add(testCase.kind)
    );
    if (!testCase.arguments) add("argumentsMissing", about);
    checkReferences(context, testCase.arguments, `Case ${testCase.id}`, about);
    for (const fixture of testCase.creates ?? []) {
      const where = `Case ${testCase.id}`;
      if (!fixtures.has(fixture))
        add("unknownFixture", { ...about, fixture }, { where });
      else if (!entry.writes.includes(fixture)) {
        add("writeScope.creates", { ...about, fixture });
      }
    }
  }
  for (const { tool, action } of entries.values()) {
    const has = kinds.get(tool) ?? new Set<string>();
    if (action === "excluded" && has.size)
      add("actionCases.excluded", { tool });
    if (action === "run" && !has.has("valid"))
      add("actionCases.noValid", { tool });
    if (action === "negative-only" && !has.has("negative")) {
      add("actionCases.noNegative", { tool });
    }
  }
}

/** A fixture is used only after the case that creates it; destruction comes last. */
function checkOrder({ plan, entries, add }: Context) {
  const creatorOf = new Map(
    plan.cases.flatMap((testCase) =>
      (testCase.creates ?? []).map((fixture) => [fixture, testCase.id] as const)
    )
  );
  const destroys = plan.cases.map(
    (testCase) => entries.get(testCase.tool)?.effect === "destructive"
  );
  const lastSafe = destroys.lastIndexOf(false);
  const created = new Set<string>();
  plan.cases.forEach((testCase, index) => {
    const about = { tool: testCase.tool, caseId: testCase.id };
    const refs = directoryFixtureReferences(testCase.arguments);
    for (const fixture of new Set(refs.map((ref) => ref.fixture))) {
      const creator = creatorOf.get(fixture);
      if (creator !== undefined && !created.has(fixture)) {
        add("order.created", { ...about, fixture }, { creator });
      }
    }
    for (const fixture of testCase.creates ?? []) created.add(fixture);
    if (destroys[index] && index < lastSafe) {
      add("order.destructive", about, {
        later: plan.cases[lastSafe]?.id ?? "",
      });
    }
  });
}

function checkCleanup(context: Context) {
  const { plan, entries, fixtures, add } = context;
  for (const step of plan.cleanup) {
    const about = { tool: step.tool, fixture: step.fixture };
    const origin = fixtures.get(step.fixture)?.origin;
    if (!origin) add("unknownFixture", about, { where: "A cleanup step" });
    if (origin === "existing") add("cleanup.existing", about);
    const action = entries.get(step.tool)?.action;
    if (!action || action === "excluded") add("cleanup.tool", about);
    const where = `The cleanup step for ${step.fixture}`;
    checkReferences(context, step.arguments, where, about);
  }
  for (const { id, origin } of fixtures.values()) {
    const removed = plan.cleanup.some((step) => step.fixture === id);
    if (origin === "created" && !removed)
      add("cleanup.missing", { fixture: id });
  }
}

function checkReferences(
  { fixtures, add }: Context,
  args: unknown,
  where: string,
  about: About
) {
  for (const { fixture, value } of directoryFixtureReferences(args)) {
    const target = fixtures.get(fixture);
    const named =
      target?.origin === "created" ? target.capture : target?.values;
    if (!target) add("unknownFixture", { ...about, fixture }, { where });
    else if (!named || !Object.hasOwn(named, value)) {
      add("unknownFixture.value", { ...about, fixture }, { where, value });
    }
  }
}

function checkLimits({ plan, add }: Context) {
  const { maxCalls, concurrency, callTimeoutMs } = plan.budget;
  const counts: Array<[IssueWording, number, number]> = [
    ["limit.tools", plan.tools.length, LIMITS.maxTools],
    ["limit.cases", plan.cases.length, LIMITS.maxCases],
    ["limit.fixtures", plan.fixtures.length, LIMITS.maxFixtures],
    ["limit.cleanup", plan.cleanup.length, LIMITS.maxCleanupSteps],
  ];
  for (const [words, count, max] of counts) {
    if (count > max) add(words, {}, { count, max });
  }
  for (const { id } of [...plan.cases, ...plan.fixtures]) {
    if (id.length === 0 || id.length > LIMITS.maxIdLength) {
      add("limit.id", {}, { id: id.slice(0, 40), max: LIMITS.maxIdLength });
    }
  }
  if (jsonLength(plan) > LIMITS.maxPlanLength) {
    add("limit.plan", {}, { max: LIMITS.maxPlanLength });
  }
  const ranges: Array<[IssueWording, number, number, number]> = [
    ["limit.maxCalls", maxCalls, 1, LIMITS.maxCalls],
    ["limit.concurrency", concurrency, 1, LIMITS.maxConcurrency],
    [
      "limit.callTimeout",
      callTimeoutMs,
      LIMITS.minCallTimeoutMs,
      LIMITS.maxCallTimeoutMs,
    ],
  ];
  for (const [words, value, min, max] of ranges) {
    if (!Number.isInteger(value) || value < min || value > max) {
      add(words, {}, { min, max });
    }
  }
}

/** Characters of canonical JSON. */
function jsonLength(value: unknown): number {
  try {
    return canonicalJson(value).length;
  } catch {
    // NaN, a function, a cycle: never sendable or storable, so over any limit.
    return Infinity;
  }
}
