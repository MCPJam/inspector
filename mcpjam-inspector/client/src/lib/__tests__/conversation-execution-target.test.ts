import { describe, expect, it } from "vitest";

import {
  describeConversationTargetDisclosure,
  readConversationExecutionTarget,
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

  it("reports UNRECORDED for a browser Playground session, which pins neither", () => {
    // This is the shape of every `origin: "playground"` row: `resumeConfig`
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
