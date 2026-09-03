import { describe, expect, test } from "vitest";
import {
  canCommit,
  committedSuiteSettingsValues,
  describeChange,
  describeDraft,
  dirtyKeys,
  initSuiteSettingsDraft,
  normalizeSuiteSettingsValues,
  readSuiteSettingsValues,
  SUITE_SETTINGS_KEYS,
  suiteSettingsReducer,
  toUpdateArgs,
  type SuiteSettingsDraft,
  type SuiteSettingsValues,
} from "../suite-settings-draft";

// =============================================================================
// The settings draft (S1).
//
// Every control in the sheet used to write on change. The draft replaces that
// with one deliberate save, and the properties worth pinning are the ones that
// decide whether the save is TRUSTWORTHY:
//
//   - it sends only what changed (a save that resent every field would
//     clobber a colleague's edit to a row this person never touched),
//   - it preserves the backend's omit-vs-null distinction exactly (getting
//     this wrong silently keeps a setting the person cleared),
//   - a concurrent edit is a marked conflict rather than a silent overwrite,
//   - and every key can be DESCRIBED, so the review dialog cannot render a
//     change nobody can read.
// =============================================================================

const BASE: SuiteSettingsValues = {
  name: "Checkout suite",
  defaultPassCriteria: { minimumPassRate: 80 },
  minIterations: 3,
  computerEnvironmentId: undefined,
  defaultMatchOptions: undefined,
  defaultPredicates: [],
  judgeConfig: undefined,
  judgeRubric: undefined,
};

const SUITE_ID = "suite-a";

const draftOf = (values: Partial<SuiteSettingsValues> = {}) =>
  initSuiteSettingsDraft({
    suiteId: SUITE_ID,
    values: { ...BASE, ...values },
  });

const edit = (
  draft: SuiteSettingsDraft,
  key: keyof SuiteSettingsValues,
  value: unknown,
) => suiteSettingsReducer(draft, { type: "edit", key, value });

const alwaysValid = () => true;

describe("only what changed is sent", () => {
  test("an untouched draft is not dirty and cannot be saved", () => {
    const draft = draftOf();
    expect(dirtyKeys(draft)).toEqual([]);
    expect(canCommit(draft, alwaysValid)).toBe(false);
  });

  test("two edits produce exactly two arguments, plus the id", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Renamed");
    draft = edit(draft, "minIterations", 5);

    const args = toUpdateArgs(draft, "suite_1");
    // A save that resent every field would clobber a colleague's edit to a row
    // this person never opened.
    expect(Object.keys(args).sort()).toEqual([
      "minIterations",
      "name",
      "suiteId",
    ]);
    expect(args.name).toBe("Renamed");
    expect(args.minIterations).toBe(5);
  });

  test("editing back to the original value un-dirties the key", () => {
    let draft = draftOf();
    draft = edit(draft, "minIterations", 5);
    draft = edit(draft, "minIterations", 3);
    expect(dirtyKeys(draft)).toEqual([]);
  });

  test("an updater is resolved against the authoritative draft", () => {
    // The form `AddCheckMenu` uses. Before this, the setter stored the
    // FUNCTION as the value: `describePredicates` and the checks list both
    // iterate it, and `for...of` over a function throws — "Add check" broke
    // the sheet at runtime, with nothing in the type system to stop it
    // (the client has no typecheck in CI).
    let draft = draftOf();
    draft = suiteSettingsReducer(draft, {
      type: "edit",
      key: "defaultPredicates",
      value: (previous: unknown) => [
        ...(previous as unknown[]),
        { type: "noToolErrors" },
      ],
    });
    expect(Array.isArray(draft.current.defaultPredicates)).toBe(true);
    expect(draft.current.defaultPredicates).toHaveLength(1);
  });

  test("two updaters in a row both land", () => {
    // The reason resolution belongs in the reducer rather than the call site:
    // a caller computing from its own last render would have the second click
    // overwrite the first.
    let draft = draftOf();
    const append = (type: string) => ({
      type: "edit" as const,
      key: "defaultPredicates" as const,
      value: (previous: unknown) => [...(previous as unknown[]), { type }],
    });
    draft = suiteSettingsReducer(draft, append("noToolErrors"));
    draft = suiteSettingsReducer(draft, append("responseContains"));
    expect(draft.current.defaultPredicates).toHaveLength(2);
  });

  test("discard returns to the last saved state", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Renamed");
    draft = suiteSettingsReducer(draft, { type: "discard" });
    expect(draft.current).toEqual(BASE);
    expect(dirtyKeys(draft)).toEqual([]);
  });
});

describe("clearing a setting is not the same as omitting it", () => {
  // The backend distinguishes an absent field (leave it alone) from `null`
  // (clear it). Every one of these was a live per-control writer's behaviour
  // before the draft existed, so getting one wrong is a silent regression:
  // the person clears a setting, the sheet says saved, and the value is still
  // there on reload.
  test("minimum iterations clears with null", () => {
    const draft = edit(draftOf(), "minIterations", undefined);
    expect(toUpdateArgs(draft, "s").minIterations).toBeNull();
  });

  test("an emptied check list clears with null", () => {
    const draft = edit(
      draftOf({ defaultPredicates: [{ type: "noToolErrors" } as never] }),
      "defaultPredicates",
      [],
    );
    expect(toUpdateArgs(draft, "s").defaultPredicates).toBeNull();
  });

  test("match options clear with null", () => {
    const draft = edit(
      draftOf({ defaultMatchOptions: { argumentMatching: "exact" } }),
      "defaultMatchOptions",
      undefined,
    );
    expect(toUpdateArgs(draft, "s").defaultMatchOptions).toBeNull();
  });

  test("the judge clears with null", () => {
    const draft = edit(
      draftOf({ judgeConfig: { goalCompletion: { enabled: true } } }),
      "judgeConfig",
      undefined,
    );
    expect(toUpdateArgs(draft, "s").judgeConfig).toBeNull();
  });

  test("the computer pin travels inside the environment envelope", () => {
    const draft = edit(draftOf(), "computerEnvironmentId", "env_1");
    const args = toUpdateArgs(draft, "s", {
      servers: ["alpha"],
      serverBindings: { alpha: "b" },
    });
    // Sending the pin alone would drop the server list beside it, because the
    // mutation takes the whole envelope.
    expect(args.environment).toEqual({
      servers: ["alpha"],
      serverBindings: { alpha: "b" },
      computerEnvironmentId: "env_1",
    });
  });

  test("clearing the pin keeps the servers and drops the field", () => {
    const draft = edit(
      draftOf({ computerEnvironmentId: "env_1" }),
      "computerEnvironmentId",
      undefined,
    );
    const args = toUpdateArgs(draft, "s", { servers: ["alpha"] }) as {
      environment: Record<string, unknown>;
    };
    expect(args.environment.servers).toEqual(["alpha"]);
    expect("computerEnvironmentId" in args.environment).toBe(false);
  });
});

describe("a concurrent edit is marked, never merged", () => {
  test("an untouched key simply takes the newer value", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Mine");
    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: SUITE_ID,
      live: { ...BASE, minIterations: 9 },
    });
    // Not a conflict: nobody disagreed about iterations, so refreshing it is
    // the correct answer rather than a question.
    expect(draft.conflicts).toEqual([]);
    expect(draft.current.minIterations).toBe(9);
    expect(draft.current.name).toBe("Mine");
  });

  test("a key both sides moved is a conflict, and the local edit is kept", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Mine");
    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: SUITE_ID,
      live: { ...BASE, name: "Theirs" },
    });
    // The one thing an automatic resolution cannot choose between. Keeping the
    // local edit and marking it is slower and correct; taking either side
    // silently is how one person's work disappears.
    expect(draft.conflicts).toEqual(["name"]);
    expect(draft.current.name).toBe("Mine");
    expect(draft.base.name).toBe("Theirs");
  });

  test("both sides landing on the SAME value is not a conflict", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Agreed");
    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: SUITE_ID,
      live: { ...BASE, name: "Agreed" },
    });
    expect(draft.conflicts).toEqual([]);
    expect(dirtyKeys(draft)).toEqual([]);
  });

  test("editing a conflicted key resolves it", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Mine");
    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: SUITE_ID,
      live: { ...BASE, name: "Theirs" },
    });
    draft = edit(draft, "name", "Decided");
    // Editing IS the decision. Still warning about it would be nagging.
    expect(draft.conflicts).toEqual([]);
  });

  test("a successful commit clears everything", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Mine");
    draft = suiteSettingsReducer(draft, {
      type: "commitSucceeded",
      suiteId: SUITE_ID,
      live: { ...BASE, name: "Mine" },
    });
    expect(dirtyKeys(draft)).toEqual([]);
    expect(draft.conflicts).toEqual([]);
  });

  test("a commit that lands after navigating away leaves the new draft alone", () => {
    // Started on suite A, the person opened suite B before the mutation
    // resolved. Without the guard, A's saved values land in B's draft and the
    // next save writes them to B.
    let onB = initSuiteSettingsDraft({
      suiteId: "suite-b",
      values: { ...BASE, name: "Suite B" },
    });
    onB = edit(onB, "name", "B renamed");

    const after = suiteSettingsReducer(onB, {
      type: "commitSucceeded",
      suiteId: SUITE_ID,
      live: { ...BASE, name: "A renamed" },
    });

    expect(after).toBe(onB);
    expect(after.current.name).toBe("B renamed");
    expect(after.base.name).toBe("Suite B");
  });

  test("a key the save could not carry stays dirty", () => {
    // The legacy fallback drops fields the old mutation does not declare and
    // says so in its toast. Rebasing them anyway would make that toast a lie:
    // the edit stops being dirty, so there is nothing left to retry once the
    // backend catches up.
    let draft = draftOf();
    draft = edit(draft, "name", "Renamed");
    draft = edit(draft, "judgeRubric", {
      criteria: [{ id: "crit_1", label: "Answers the question" }],
    });

    draft = suiteSettingsReducer(draft, {
      type: "commitSucceeded",
      suiteId: SUITE_ID,
      // What the save actually wrote: the name travelled, the rubric did not.
      live: { ...BASE, name: "Renamed" },
      retained: ["judgeRubric"],
    });

    expect(dirtyKeys(draft)).toEqual(["judgeRubric"]);
    expect(draft.current.name).toBe("Renamed");
    expect(draft.current.judgeRubric).toEqual({
      criteria: [{ id: "crit_1", label: "Answers the question" }],
    });
    // And the draft agrees with the server about what is stored, so a later
    // save still sends the rubric as a change.
    expect(draft.base.judgeRubric).toBeUndefined();
  });

  test("a retained key on the wrong suite is still ignored", () => {
    // The `retained` branch is a second return path, and it needs the same
    // guard as the first one.
    let onB = initSuiteSettingsDraft({
      suiteId: "suite-b",
      values: { ...BASE, name: "Suite B" },
    });
    onB = edit(onB, "name", "B renamed");

    const after = suiteSettingsReducer(onB, {
      type: "commitSucceeded",
      suiteId: SUITE_ID,
      live: { ...BASE, name: "A renamed" },
      retained: ["judgeRubric"],
    });

    expect(after).toBe(onB);
  });
});

describe("what is saved is what the draft then holds", () => {
  test("a name with surrounding whitespace normalizes the same way twice", () => {
    // `toUpdateArgs` trims; the commit rebases onto the normalized values.
    // Two definitions of "what the server stored" is how a person ends up
    // looking at their own whitespace in the input while the server holds
    // something else.
    const draft = edit(draftOf(), "name", "  Renamed  ");
    expect(toUpdateArgs(draft, "s").name).toBe("Renamed");
    expect(normalizeSuiteSettingsValues(draft.current).name).toBe("Renamed");
  });

  test("committing the saved values leaves nothing dirty", () => {
    let draft = edit(draftOf(), "name", "  Renamed  ");
    draft = suiteSettingsReducer(draft, {
      type: "commitSucceeded",
      suiteId: SUITE_ID,
      live: committedSuiteSettingsValues(draft),
    });
    expect(dirtyKeys(draft)).toEqual([]);
    expect(draft.current.name).toBe("Renamed");
  });

  test("a name this save never sent is left exactly as the server has it", () => {
    // A stored name with surrounding whitespace, and an edit to some other
    // row. `toUpdateArgs` omits `name`, so the server still holds the padded
    // value — trimming it locally would make the draft disagree with the
    // database about a field nobody touched.
    const padded = draftOf({ name: "  Padded  " });
    const draft = edit(padded, "minIterations", 7);
    expect("name" in toUpdateArgs(draft, "s")).toBe(false);
    expect(committedSuiteSettingsValues(draft).name).toBe("  Padded  ");
  });
});

describe("a draft the server would refuse cannot be saved", () => {
  test("an empty name is refused before the round trip", () => {
    const draft = edit(draftOf(), "name", "   ");
    expect(canCommit(draft, alwaysValid)).toBe(false);
  });

  test("a half-written check is refused", () => {
    const draft = edit(draftOf(), "name", "Fine");
    // A check that is half-written is not a check, and learning that after the
    // click is a worse way to learn it.
    expect(canCommit(draft, () => false)).toBe(false);
  });

  test("a valid change can be saved", () => {
    const draft = edit(draftOf(), "name", "Fine");
    expect(canCommit(draft, alwaysValid)).toBe(true);
  });
});

describe("every change can be read", () => {
  test("describeChange is total over the draft's keys", () => {
    // The compile-time totality is enforced by the switch having no default;
    // this catches the runtime half — a key that returns an empty or
    // placeholder row would render as a change nobody can read.
    for (const key of SUITE_SETTINGS_KEYS) {
      const row = describeChange(key, BASE, BASE);
      expect(row.label.length, `${key} needs a label`).toBeGreaterThan(0);
      expect(row.before.length, `${key} needs a before`).toBeGreaterThan(0);
      expect(row.after.length, `${key} needs an after`).toBeGreaterThan(0);
    }
  });

  test("it names values, not shapes", () => {
    let draft = draftOf();
    draft = edit(draft, "defaultPassCriteria", { minimumPassRate: 90 });
    draft = edit(draft, "judgeConfig", {
      goalCompletion: { enabled: true, role: "advisory", threshold: 0.8 },
    });

    const rows = describeDraft(draft);
    const accuracy = rows.find((row) => row.key === "defaultPassCriteria");
    expect(accuracy).toMatchObject({ before: "80%", after: "90%" });
    const judge = rows.find((row) => row.key === "judgeConfig");
    // "Not configured", not "Off": an absent judgeConfig resolves through
    // GOAL_COMPLETION_DEFAULTS to an ENABLED advisory judge that never
    // auto-runs, so calling it off described a change that was not happening.
    expect(judge!.before).toBe("Not configured");
    expect(judge!.after).toContain("Advisory");
    expect(judge!.after).toContain("80%");
  });

  test("checks are described by kind and count, not by their operands", () => {
    const draft = edit(draftOf(), "defaultPredicates", [
      { type: "noToolErrors" },
      { type: "responseContains", text: "a" },
      { type: "responseContains", text: "b" },
    ] as never);
    const row = describeDraft(draft)[0];
    expect(row.before).toBe("None");
    // Every operand would be unreadable at five checks, and is not what the
    // reader is asking.
    expect(row.after).toContain("×2");
  });

  test("only dirty keys are described", () => {
    const draft = edit(draftOf(), "name", "Renamed");
    expect(describeDraft(draft).map((row) => row.key)).toEqual(["name"]);
  });
});

describe("reading a suite into the draft", () => {
  test("absent and empty check lists are the same state", () => {
    // Two spellings of "no checks" is how one of them ends up rendering as an
    // unsaved change the person never made.
    expect(readSuiteSettingsValues({}).defaultPredicates).toEqual([]);
    const draft = initSuiteSettingsDraft({
      suiteId: SUITE_ID,
      values: readSuiteSettingsValues({ defaultPredicates: [] }),
    });
    expect(dirtyKeys(draft)).toEqual([]);
  });

  test("a missing name reads as empty rather than undefined", () => {
    expect(readSuiteSettingsValues({}).name).toBe("");
  });
});

// =============================================================================
// Review follow-ups.
//
// A draft is state about ONE suite, and every test here is a way that stopped
// being true — by navigation, by a second rebase, or by a save that carried a
// field the deployment does not have.
// =============================================================================

describe("a draft belongs to one suite", () => {
  test("rebasing onto a different suite starts a new draft", () => {
    let draft = draftOf();
    draft = edit(draft, "name", "Suite A's unsaved name");

    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: "suite-b",
      live: { ...BASE, name: "Suite B" },
    });

    // The failure this prevents: the component is not remounted between
    // suites, so without an identity check A's unsaved name survives, renders
    // as an unsaved change on B, and Save writes it to B.
    expect(draft.suiteId).toBe("suite-b");
    expect(draft.current.name).toBe("Suite B");
    expect(dirtyKeys(draft)).toEqual([]);
    expect(draft.conflicts).toEqual([]);
  });
});

describe("a conflict survives until someone resolves it", () => {
  test("an unrelated later change does not clear the marker", () => {
    let draft = draftOf();
    draft = edit(draft, "minIterations", 5);
    // A colleague sets it to 7 — a real disagreement (BASE is 3).
    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: SUITE_ID,
      live: { ...BASE, minIterations: 7 },
    });
    expect(draft.conflicts).toEqual(["minIterations"]);

    // The same colleague then renames the suite. Recomputing conflicts from
    // the new base would find iterations unchanged BETWEEN the two rebases and
    // silently drop the warning — and the next save would overwrite their 7
    // with no notice at all.
    draft = suiteSettingsReducer(draft, {
      type: "rebase",
      suiteId: SUITE_ID,
      live: { ...BASE, minIterations: 7, name: "Renamed by them" },
    });

    expect(draft.conflicts).toEqual(["minIterations"]);
    expect(draft.current.minIterations).toBe(5);
  });
});

describe("a clear is spelled the way the mutation accepts", () => {
  test("pass criteria is omitted rather than nulled", () => {
    let draft = draftOf({ defaultPassCriteria: { minimumPassRate: 80 } });
    draft = edit(draft, "defaultPassCriteria", undefined);
    const args = toUpdateArgs(draft, "suite-1");
    // `v.optional(passCriteriaValidator)` has no null member, so sending null
    // rejects the whole batched save — every other setting in it included.
    expect("defaultPassCriteria" in args).toBe(false);
  });
});
