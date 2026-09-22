/**
 * What Confirm is allowed to SAY about where a reused goal will run.
 *
 * Every case here is a sentence someone reads before spending a wave, so the
 * bar is that it is never wrong in either direction: no move claimed that will
 * not happen, and no move hidden that will.
 *
 * Both target modes are covered, because they are not equally common. Named
 * environments are behind a flag held by one account; every other project
 * composes clients and server groups into ad-hoc rows, and that is where the
 * silent move usually happens.
 */
import { describe, expect, it } from "vitest";

import {
  describeReusedEnvironmentMove,
  sameEnvironmentSelection,
  type EnvironmentMoveRow,
} from "../reused-environment-move";

function rows(
  ...entries: [
    id: string,
    label: string,
    hostId: string,
    serverAttachmentId: string | null,
  ][]
): ReadonlyMap<string, EnvironmentMoveRow> {
  return new Map(
    entries.map(([environmentId, label, hostId, serverAttachmentId]) => [
      environmentId,
      { environmentId, label, hostId, serverAttachmentId },
    ]),
  );
}

/** Named environments: the flagged account's shape, and the incident's. */
const NAMED = rows(
  ["env-terac", "MCPJam #1", "host-claude", "att-terac"],
  ["env-excalidraw", "MCPJam #2", "host-claude", "att-excalidraw"],
  ["env-terac-2", "MCPJam staging", "host-claude", "att-terac"],
);

/** Ad-hoc rows: what every unflagged project actually launches against. */
const ADHOC = rows(
  ["adhoc-claude", "Claude", "host-claude", "att-shared"],
  ["adhoc-cursor", "Cursor", "host-cursor", "att-shared"],
  ["adhoc-claude-other", "Claude #2", "host-claude", "att-other"],
);

const hostName = (hostId: string) =>
  ({ "host-claude": "Claude", "host-cursor": "Cursor" })[hostId];

describe("sameEnvironmentSelection", () => {
  it("ignores order, because a fan-out is a set of targets not a sequence", () => {
    expect(sameEnvironmentSelection(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("separates a subset from a match", () => {
    expect(sameEnvironmentSelection(["a"], ["a", "b"])).toBe(false);
    expect(sameEnvironmentSelection(["a", "b"], ["a"])).toBe(false);
  });
});

describe("describeReusedEnvironmentMove — named environments", () => {
  it("reports the move that caused the incident, and names both ends", () => {
    const move = describeReusedEnvironmentMove({
      goals: Array.from({ length: 15 }, () => ({
        environmentIds: ["env-terac"],
      })),
      selection: ["env-excalidraw"],
      rowsById: NAMED,
    });

    expect(move?.goalCount).toBe(15);
    expect(move?.fromLabels).toEqual(["MCPJam #1"]);
    expect(move?.differentServerGroup).toBe(true);
    // Same client throughout — only the server group changed.
    expect(move?.differentClient).toBe(false);
  });

  it("says nothing when the stored fan-out already IS the selection", () => {
    expect(
      describeReusedEnvironmentMove({
        goals: [{ environmentIds: ["env-terac"] }],
        selection: ["env-terac"],
        rowsById: NAMED,
      }),
    ).toBeNull();
  });

  it("says nothing when the selection merely reorders the stored fan-out", () => {
    expect(
      describeReusedEnvironmentMove({
        goals: [{ environmentIds: ["env-terac", "env-excalidraw"] }],
        selection: ["env-excalidraw", "env-terac"],
        rowsById: NAMED,
      }),
    ).toBeNull();
  });

  it("reports a move between rows that share a server group, without cautioning", () => {
    const move = describeReusedEnvironmentMove({
      goals: [{ environmentIds: ["env-terac"] }],
      selection: ["env-terac-2"],
      rowsById: NAMED,
    });

    // Still running the tools these goals were written for. Worth disclosing,
    // not worth a caution.
    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(false);
    expect(move?.differentClient).toBe(false);
  });

  it("counts only the goals that move, in a mixed persona", () => {
    const move = describeReusedEnvironmentMove({
      goals: [
        { environmentIds: ["env-terac"] },
        { environmentIds: ["env-excalidraw"] },
        { environmentIds: null, hostIds: [] },
      ],
      selection: ["env-excalidraw"],
      rowsById: NAMED,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual(["MCPJam #1"]);
  });
});

describe("describeReusedEnvironmentMove — composed clients (flag off)", () => {
  it("catches a goal moving to a different CLIENT", () => {
    // The unflagged shape of the same bug: the composer seeds the first client,
    // and a returning user's goals were set up against another one.
    const move = describeReusedEnvironmentMove({
      goals: [{ environmentIds: ["adhoc-cursor"] }],
      selection: ["adhoc-claude"],
      rowsById: ADHOC,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual(["Cursor"]);
    expect(move?.differentClient).toBe(true);
    // Same server group, so only the client caution fires.
    expect(move?.differentServerGroup).toBe(false);
  });

  it("stays quiet when the composition resolves to the goal's own row", () => {
    expect(
      describeReusedEnvironmentMove({
        goals: [{ environmentIds: ["adhoc-claude"] }],
        selection: ["adhoc-claude"],
        rowsById: ADHOC,
      }),
    ).toBeNull();
  });

  it("stays quiet when the destination shares one of several origin clients", () => {
    const move = describeReusedEnvironmentMove({
      goals: [{ environmentIds: ["adhoc-claude", "adhoc-cursor"] }],
      selection: ["adhoc-claude"],
      rowsById: ADHOC,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.differentClient).toBe(false);
  });
});

describe("describeReusedEnvironmentMove — legacy journeys", () => {
  it("names the client a legacy goal was set up against", () => {
    // A legacy journey has no environment ids, but it does have hosts, and
    // `listJourneysByPersona` already returns them. Treating it as unknowable
    // hid a real move.
    const move = describeReusedEnvironmentMove({
      goals: [
        {
          environmentIds: null,
          hostIds: ["host-cursor"],
          serverAttachmentId: "att-shared",
        },
      ],
      selection: ["adhoc-claude"],
      rowsById: ADHOC,
      hostName,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual(["Cursor"]);
    expect(move?.differentClient).toBe(true);
  });

  it("stays quiet when a legacy goal already runs where the launch will", () => {
    // The override still fires for a legacy row, because it has nothing else to
    // run against. Announcing that every time would be noise.
    expect(
      describeReusedEnvironmentMove({
        goals: [
          {
            environmentIds: null,
            hostIds: ["host-claude"],
            serverAttachmentId: "att-shared",
          },
        ],
        selection: ["adhoc-claude"],
        rowsById: ADHOC,
        hostName,
      }),
    ).toBeNull();
  });

  it("catches a legacy goal whose SERVER GROUP changes on the same client", () => {
    const move = describeReusedEnvironmentMove({
      goals: [
        {
          environmentIds: null,
          hostIds: ["host-claude"],
          serverAttachmentId: "att-shared",
        },
      ],
      selection: ["adhoc-claude-other"],
      rowsById: ADHOC,
      hostName,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(true);
    expect(move?.differentClient).toBe(false);
  });

  it("says nothing about a goal that records nowhere at all", () => {
    expect(
      describeReusedEnvironmentMove({
        goals: [{ environmentIds: null, hostIds: [] }],
        selection: ["adhoc-claude"],
        rowsById: ADHOC,
        hostName,
      }),
    ).toBeNull();
  });
});

describe("describeReusedEnvironmentMove — what it refuses to claim", () => {
  it("discloses a move whose origin it cannot see, and claims nothing else", () => {
    const move = describeReusedEnvironmentMove({
      goals: [{ environmentIds: ["env-vanished"] }],
      selection: ["env-excalidraw"],
      rowsById: NAMED,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual([]);
    expect(move?.differentClient).toBe(false);
    expect(move?.differentServerGroup).toBe(false);
  });

  it("stays quiet when no target is selected at all", () => {
    // No selection means no override, and every reused goal runs on what it
    // already carries.
    expect(
      describeReusedEnvironmentMove({
        goals: [{ environmentIds: ["env-terac"] }],
        selection: [],
        rowsById: NAMED,
      }),
    ).toBeNull();
  });

  it("cautions when a group's goals move to the client's own servers", () => {
    // `null` is the client's own servers, not an unknown: those are different
    // tools from the group the goals were written against.
    const move = describeReusedEnvironmentMove({
      goals: [{ environmentIds: ["env-terac"] }],
      selection: ["env-bare"],
      rowsById: rows(
        ["env-terac", "MCPJam #1", "host-claude", "att-terac"],
        ["env-bare", "Bare client", "host-claude", null],
      ),
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(true);
    expect(move?.differentClient).toBe(false);
  });

  it("cautions when a legacy goal on the client's own servers moves to a group", () => {
    const move = describeReusedEnvironmentMove({
      goals: [
        {
          environmentIds: null,
          hostIds: ["host-claude"],
          serverAttachmentId: null,
        },
      ],
      selection: ["adhoc-claude"],
      rowsById: ADHOC,
      hostName,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual(["Claude"]);
    expect(move?.differentServerGroup).toBe(true);
    expect(move?.differentClient).toBe(false);
  });

  it("does not caution when both sides run the client's own servers", () => {
    const move = describeReusedEnvironmentMove({
      goals: [{ environmentIds: ["env-bare"] }],
      selection: ["env-bare-2"],
      rowsById: rows(
        ["env-bare", "Bare client", "host-claude", null],
        ["env-bare-2", "Bare client #2", "host-claude", null],
      ),
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(false);
  });
});
