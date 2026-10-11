import { describe, expect, it } from "vitest";

import {
  describeConversationTargetDisclosure,
  readConversationExecutionTarget,
  readHiddenEnvironmentConversationTarget,
} from "../conversation-execution-target";

describe("readConversationExecutionTarget", () => {
  it("reads the environment a session pinned", () => {
    expect(
      readConversationExecutionTarget({
        resumeConfig: { environmentId: "env_1" },
      }),
    ).toEqual({ kind: "environment", environmentId: "env_1" });
  });

  it("reads a stamped host when there is no environment pin", () => {
    expect(readConversationExecutionTarget({ hostId: "host_1" })).toEqual({
      kind: "host",
      hostId: "host_1",
    });
  });

  it("prefers the environment when a row somehow carries both", () => {
    // An environment IS the execution statement on the wire; a host id beside
    // it is the environment's resolved host, not a second target.
    expect(
      readConversationExecutionTarget({
        hostId: "host_1",
        resumeConfig: { environmentId: "env_1" },
      }),
    ).toEqual({ kind: "environment", environmentId: "env_1" });
  });

  it("reports UNRECORDED for a legacy session without a target", () => {
    // Older `origin: "playground"` rows have this shape: `resumeConfig`
    // carries prompt/temperature/servers and no target field at all.
    expect(
      readConversationExecutionTarget({
        resumeConfig: { environmentId: undefined },
      }),
    ).toEqual({ kind: "unrecorded" });
    expect(readConversationExecutionTarget({})).toEqual({
      kind: "unrecorded",
    });
    expect(readConversationExecutionTarget(null)).toEqual({
      kind: "unrecorded",
    });
  });

  it("treats a blank id as absent rather than as a target that cannot resolve", () => {
    expect(
      readConversationExecutionTarget({
        hostId: "   ",
        resumeConfig: { environmentId: "" },
      }),
    ).toEqual({ kind: "unrecorded" });
  });
});

describe("describeConversationTargetDisclosure", () => {
  it("says nothing when no persisted conversation is open", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: null,
        composer: { kind: "host", hostId: "host_1" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("says nothing when the composer is on the environment the conversation ran", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "environment", environmentId: "env_1" },
        composer: { kind: "environment", environmentId: "env_1" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("says nothing when the composer is on the host the conversation ran", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "host", hostId: "host_1" },
        composer: { kind: "host", hostId: "host_1" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("reports UNRECORDED rather than letting the ambient selection read as history", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "unrecorded" },
        composer: { kind: "host", hostId: "cli-box-host" },
      }),
    ).toEqual({ kind: "unrecorded" });
  });

  it("still reports UNRECORDED when nothing is selected either", () => {
    // "No host selected" is not evidence that the conversation had none.
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "unrecorded" },
        composer: { kind: "host", hostId: null },
      }),
    ).toEqual({ kind: "unrecorded" });
  });

  it("reports a mismatch when the composer points at a different environment", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "environment", environmentId: "env_recorded" },
        composer: { kind: "environment", environmentId: "env_other" },
      }),
    ).toEqual({
      kind: "mismatch",
      recorded: { kind: "environment", environmentId: "env_recorded" },
    });
  });

  it("reports a mismatch when an environment conversation is opened in host mode", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "environment", environmentId: "env_recorded" },
        composer: { kind: "host", hostId: "host_1" },
      }),
    ).toEqual({
      kind: "mismatch",
      recorded: { kind: "environment", environmentId: "env_recorded" },
    });
  });

  it("reports a mismatch when a recorded host is opened with no host selected", () => {
    // `hostId: null` is the composer's shape when the host picker is empty —
    // on a cold load, or after the previewed host was deleted. "Nothing
    // selected" is not the recorded host, so this is a mismatch, not `none`:
    // treating it as agreement would silently drop the gate exactly where the
    // composer says the least about where a reply would run.
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "host", hostId: "cursor-host" },
        composer: { kind: "host", hostId: null },
      }),
    ).toEqual({
      kind: "mismatch",
      recorded: { kind: "host", hostId: "cursor-host" },
    });
  });

  it("reports a mismatch when the previewed host is not the recorded one", () => {
    expect(
      describeConversationTargetDisclosure({
        recorded: { kind: "host", hostId: "cursor-host" },
        composer: { kind: "host", hostId: "cli-box-host" },
      }),
    ).toEqual({
      kind: "mismatch",
      recorded: { kind: "host", hostId: "cursor-host" },
    });
  });
});

describe("recorded resume destination", () => {
  it("prefers the last saved target over a legacy first-turn environment pin", () => {
    expect(
      readConversationExecutionTarget({
        resumeConfig: {
          environmentId: "original",
          executionTarget: { kind: "host", hostId: "continued" },
        },
      }),
    ).toEqual({ kind: "host", hostId: "continued" });
  });
  it("distinguishes an explicit ad-hoc run from missing metadata", () => {
    const recorded = readConversationExecutionTarget({
      resumeConfig: { executionTarget: { kind: "adhoc" } },
    });
    expect(
      describeConversationTargetDisclosure({
        recorded,
        composer: { kind: "host", hostId: null },
      }),
    ).toEqual({ kind: "none" });
    expect(
      describeConversationTargetDisclosure({
        recorded,
        composer: { kind: "host", hostId: "other" },
      }).kind,
    ).toBe("mismatch");
  });
});

describe("a conversation that ran as the Playground's hidden environment", () => {
  const recorded = readConversationExecutionTarget({
    resumeConfig: {
      executionTarget: { kind: "environment", environmentId: "env_hidden" },
    },
  });
  const adhocRow = {
    environmentId: "env_hidden",
    hostId: "host_1",
    origin: "adhoc" as const,
  };

  it("reads as its client while the environments UI is hidden, so reopening it discloses nothing", async () => {
    const target = await readHiddenEnvironmentConversationTarget(recorded, {
      environmentsEnabled: false,
      loadEnvironment: async () => adhocRow,
    });
    expect(target).toEqual({ kind: "host", hostId: "host_1" });
    // The composer, on that client and still carrying its plugins through
    // whatever environment it composes now, describes the conversation.
    expect(
      describeConversationTargetDisclosure({
        recorded: target,
        composer: { kind: "host", hostId: "host_1" },
      }),
    ).toEqual({ kind: "none" });
    // Another client is still another place.
    expect(
      describeConversationTargetDisclosure({
        recorded: target,
        composer: { kind: "host", hostId: "host_2" },
      }).kind,
    ).toBe("mismatch");
  });

  it("leaves a NAMED environment as recorded — someone chose it", async () => {
    await expect(
      readHiddenEnvironmentConversationTarget(recorded, {
        environmentsEnabled: false,
        loadEnvironment: async () => ({
          ...adhocRow,
          origin: "named" as const,
          name: "Staging",
        }),
      }),
    ).resolves.toEqual(recorded);
  });

  it("translates nothing while the environments UI is on", async () => {
    let read = false;
    await expect(
      readHiddenEnvironmentConversationTarget(recorded, {
        environmentsEnabled: true,
        loadEnvironment: async () => {
          read = true;
          return adhocRow;
        },
      }),
    ).resolves.toEqual(recorded);
    expect(read).toBe(false);
  });

  it("keeps the recorded target when the row can't be read", async () => {
    for (const loadEnvironment of [
      async () => null,
      async () => {
        throw new Error("offline");
      },
    ]) {
      await expect(
        readHiddenEnvironmentConversationTarget(recorded, {
          environmentsEnabled: false,
          loadEnvironment,
        }),
      ).resolves.toEqual(recorded);
    }
  });

  it("passes a client or ad-hoc target through untouched", async () => {
    const loadEnvironment = async () => adhocRow;
    for (const target of [
      { kind: "host", hostId: "h" } as const,
      { kind: "adhoc" } as const,
      { kind: "unrecorded" } as const,
    ]) {
      await expect(
        readHiddenEnvironmentConversationTarget(target, {
          environmentsEnabled: false,
          loadEnvironment,
        }),
      ).resolves.toEqual(target);
    }
  });
});
