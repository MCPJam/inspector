import { describe, expect, it } from "vitest";
import {
  runClientIdentity,
  runContextKey,
  runHostLabel,
  snapshotTestModels,
} from "../helpers";
import {
  pairingKey,
  previousCompletedRunOf,
} from "../../evaluate/run-verdict-hero-deltas";
import type { EvalSuiteRun } from "../types";

const legacy = (style = "claude") => ({
  client: {
    name: "Stored name",
    hostStyle: style,
    source: "suite_default" as const,
  },
});

describe("durable run client identity", () => {
  it("labels a backfilled style and keeps unknown styles' stored names", () => {
    expect(runClientIdentity(legacy())).toMatchObject({
      name: "Claude",
      key: "style:claude",
    });
    expect(runClientIdentity(legacy("custom"))).toMatchObject({
      name: "Stored name",
      key: "style:custom",
    });
    expect(runContextKey(legacy())).toBe("style:claude");
  });
  it("uses live renames, then durable names when the host is deleted", () => {
    const run = {
      client: {
        name: "Frozen",
        namedHostId: "h1",
        source: "attached_host" as const,
      },
    };
    expect(runClientIdentity(run, new Map([["h1", "Renamed"]])).name).toBe(
      "Renamed",
    );
    expect(runClientIdentity(run).name).toBe("Frozen");
    expect(runClientIdentity(run, new Map([["h1", "  "]])).name).toBe("Frozen");
  });
  it("handles SDK and mixed-version runs without inventing a host", () => {
    expect(
      runClientIdentity({ client: { name: "SDK harness", source: "sdk" } }),
    ).toMatchObject({ name: "SDK harness", key: "sdk" });
    expect(
      runClientIdentity({ namedHostId: "h1" }, new Map([["h1", "Legacy"]]))
        .name,
    ).toBe("Legacy");
    expect(runClientIdentity({})).toEqual({
      name: "Suite default",
      key: "style:unknown",
      source: "unknown",
    });
    expect(
      runHostLabel({
        configSnapshot: {
          environmentRef: {
            environmentId: "secret",
            name: "Hidden",
            revision: 1,
          },
        },
      }),
    ).toBeNull();
  });
  it("normalizes persisted and singular snapshot models", () => {
    expect(
      snapshotTestModels({
        models: [{ model: "a", provider: "p" }],
        model: "old",
      }),
    ).toEqual([{ model: "a", provider: "p" }]);
    expect(snapshotTestModels({ model: "old", provider: "p" })).toEqual([
      { model: "old", provider: "p" },
    ]);
    expect(snapshotTestModels({ models: [], model: "old" })).toEqual([]);
    expect(snapshotTestModels({})).toEqual([]);
  });
  it("pairs historical runs only within the same client and model", () => {
    const current = {
      ...legacy(),
      _id: "new",
      status: "completed",
      runNumber: 3,
      effectiveModelId: "m",
    } as EvalSuiteRun;
    const same = { ...current, _id: "same", runNumber: 1 };
    const other = {
      ...current,
      ...legacy("chatgpt"),
      _id: "other",
      runNumber: 2,
    };
    expect(pairingKey(current)).toBe(pairingKey(same));
    expect(pairingKey(current)).not.toBe(pairingKey(other));
    expect(previousCompletedRunOf(current, [same, other])).toBe(same);
  });
});
