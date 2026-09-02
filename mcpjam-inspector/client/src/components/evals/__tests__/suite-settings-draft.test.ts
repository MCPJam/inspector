import { describe, expect, test } from "vitest";
import {
  canCommit,
  describeChange,
  describeDraft,
  dirtyKeys,
  initSuiteSettingsDraft,
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

const draftOf = (values: Partial<SuiteSettingsValues> = {}) =>
  initSuiteSettingsDraft({ ...BASE, ...values });

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
      live: { ...BASE, name: "Mine" },
    });
    expect(dirtyKeys(draft)).toEqual([]);
    expect(draft.conflicts).toEqual([]);
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
    expect(judge!.before).toBe("Off");
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
    const draft = initSuiteSettingsDraft(
      readSuiteSettingsValues({ defaultPredicates: [] }),
    );
    expect(dirtyKeys(draft)).toEqual([]);
  });

  test("a missing name reads as empty rather than undefined", () => {
    expect(readSuiteSettingsValues({}).name).toBe("");
  });
});
