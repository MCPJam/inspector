/**
 * What Confirm is allowed to SAY about a reused goal's environment.
 *
 * Every case here is a sentence the user reads before spending a wave, so the
 * bar is that the notice is never wrong in either direction: no move claimed
 * that will not happen, and no move hidden that will.
 */
import { describe, expect, it } from "vitest";

import {
  describeReusedEnvironmentMove,
  sameEnvironmentSelection,
  type EnvironmentMoveRow,
} from "../reused-environment-move";

function rows(
  ...entries: [id: string, label: string, serverAttachmentId: string | null][]
): ReadonlyMap<string, EnvironmentMoveRow> {
  return new Map(
    entries.map(([environmentId, label, serverAttachmentId]) => [
      environmentId,
      { environmentId, label, serverAttachmentId },
    ]),
  );
}

const TERAC = rows(
  ["env-terac", "MCPJam", "att-terac"],
  ["env-excalidraw", "MCPJam", "att-excalidraw"],
  ["env-terac-2", "MCPJam staging", "att-terac"],
);

describe("sameEnvironmentSelection", () => {
  it("ignores order, because a fan-out is a set of targets and not a sequence", () => {
    expect(sameEnvironmentSelection(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("separates a subset from a match", () => {
    expect(sameEnvironmentSelection(["a"], ["a", "b"])).toBe(false);
    expect(sameEnvironmentSelection(["a", "b"], ["a"])).toBe(false);
  });

  it("treats a legacy journey's absent fan-out as empty", () => {
    expect(sameEnvironmentSelection(null, [])).toBe(true);
    expect(sameEnvironmentSelection(null, ["a"])).toBe(false);
  });
});

describe("describeReusedEnvironmentMove", () => {
  it("reports the move that caused the incident, and names both ends", () => {
    // 15 terac goals, launched with the Excalidraw environment selected.
    const move = describeReusedEnvironmentMove({
      storedEnvironmentIds: Array.from({ length: 15 }, () => ["env-terac"]),
      selection: ["env-excalidraw"],
      rowsById: TERAC,
    });

    expect(move).not.toBeNull();
    expect(move?.goalCount).toBe(15);
    expect(move?.fromLabels).toEqual(["MCPJam"]);
    expect(move?.differentServerGroup).toBe(true);
  });

  it("says nothing when the stored fan-out already IS the selection", () => {
    expect(
      describeReusedEnvironmentMove({
        storedEnvironmentIds: [["env-terac"], ["env-terac"]],
        selection: ["env-terac"],
        rowsById: TERAC,
      }),
    ).toBeNull();
  });

  it("says nothing when the selection is a reordering of the stored fan-out", () => {
    expect(
      describeReusedEnvironmentMove({
        storedEnvironmentIds: [["env-terac", "env-excalidraw"]],
        selection: ["env-excalidraw", "env-terac"],
        rowsById: TERAC,
      }),
    ).toBeNull();
  });

  it("does not call a LEGACY journey's override a move", () => {
    // `null` is a journey that never carried an environment. The launch does
    // override it — it has nothing else to run against — but there is no
    // authored environment to move it off, and claiming one would invent a
    // history the row never had.
    expect(
      describeReusedEnvironmentMove({
        storedEnvironmentIds: [null, undefined],
        selection: ["env-excalidraw"],
        rowsById: TERAC,
      }),
    ).toBeNull();
  });

  it("counts only the goals that actually move, in a mixed persona", () => {
    const move = describeReusedEnvironmentMove({
      storedEnvironmentIds: [
        ["env-terac"], // moves
        ["env-excalidraw"], // already the selection
        null, // legacy
      ],
      selection: ["env-excalidraw"],
      rowsById: TERAC,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual(["MCPJam"]);
  });

  it("stays quiet about server groups when the move keeps the same one", () => {
    const move = describeReusedEnvironmentMove({
      storedEnvironmentIds: [["env-terac"]],
      selection: ["env-terac-2"],
      rowsById: TERAC,
    });

    // A different environment on the SAME server group still runs the tools
    // these goals were written for — worth disclosing, not worth a caution.
    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(false);
  });

  it("stays quiet when the destination shares ONE of several origin groups", () => {
    const move = describeReusedEnvironmentMove({
      storedEnvironmentIds: [["env-terac", "env-excalidraw"]],
      selection: ["env-excalidraw"],
      rowsById: TERAC,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(false);
  });

  it("discloses the move but claims nothing it cannot see", () => {
    // The stored environment resolves to no row this flow holds (archived, or
    // left over from another project). The move still happens, so it is still
    // announced — but with no origin name and no server-group caution, because
    // both would be guesses.
    const move = describeReusedEnvironmentMove({
      storedEnvironmentIds: [["env-vanished"]],
      selection: ["env-excalidraw"],
      rowsById: TERAC,
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.fromLabels).toEqual([]);
    expect(move?.differentServerGroup).toBe(false);
  });

  it("stays quiet when no environment is selected at all", () => {
    // With an empty selection the launch sends no override and every reused
    // goal runs its own fan-out. Nothing moves.
    expect(
      describeReusedEnvironmentMove({
        storedEnvironmentIds: [["env-terac"]],
        selection: [],
        rowsById: TERAC,
      }),
    ).toBeNull();
  });

  it("does not caution when the destination row carries no server group", () => {
    const move = describeReusedEnvironmentMove({
      storedEnvironmentIds: [["env-terac"]],
      selection: ["env-client-servers"],
      rowsById: rows(
        ["env-terac", "MCPJam", "att-terac"],
        ["env-client-servers", "Bare client", null],
      ),
    });

    expect(move?.goalCount).toBe(1);
    expect(move?.differentServerGroup).toBe(false);
  });
});
