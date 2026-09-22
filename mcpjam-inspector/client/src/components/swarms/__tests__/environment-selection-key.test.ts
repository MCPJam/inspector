/**
 * The create flow's environment-selection key.
 *
 * This key decides whether previously resolved environments and already-created
 * journeys can be reused. Getting it wrong is SILENT: the flow still runs, it
 * just runs the wrong thing — which is why the invariant is tested directly.
 */
import { describe, expect, it } from "vitest";
import { buildEnvironmentSelectionKey } from "../new-swarm-flow-draft";

const BASE = {
  composeMode: false,
  environmentIds: [] as string[],
  hostIds: ["host-1"],
  serverAttachmentId: null,
  computerEnvironmentId: null,
  customized: false,
};

describe("buildEnvironmentSelectionKey", () => {
  it("changes when a selected skill is pinned to a different revision", () => {
    // The regression this exists for: `skillIds` is identical on both sides, so
    // a key built from ids alone would compare equal and the flow would reuse
    // journeys created against the OLD revision.
    const latest = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: { skillIds: ["skill-refunds"] },
    });
    const pinned = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: {
        skillIds: ["skill-refunds"],
        versionPins: [{ skillId: "skill-refunds", versionId: "ver-1" }],
      },
    });
    expect(pinned).not.toBe(latest);
  });

  it("changes when a pin moves from one revision to another", () => {
    const v1 = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: {
        skillIds: ["skill-refunds"],
        versionPins: [{ skillId: "skill-refunds", versionId: "ver-1" }],
      },
    });
    const v2 = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: {
        skillIds: ["skill-refunds"],
        versionPins: [{ skillId: "skill-refunds", versionId: "ver-2" }],
      },
    });
    expect(v2).not.toBe(v1);
  });

  it("is stable across pin ORDER — which revision each skill runs is the identity", () => {
    const a = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: {
        skillIds: ["skill-a", "skill-b"],
        versionPins: [
          { skillId: "skill-a", versionId: "ver-1" },
          { skillId: "skill-b", versionId: "ver-9" },
        ],
      },
    });
    const b = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: {
        skillIds: ["skill-a", "skill-b"],
        versionPins: [
          { skillId: "skill-b", versionId: "ver-9" },
          { skillId: "skill-a", versionId: "ver-1" },
        ],
      },
    });
    expect(a).toBe(b);
  });

  it("treats no pins and an empty pin list as the same selection", () => {
    // A picker mid-edit can produce `[]`; the backend stores absent. Neither
    // pins anything, so neither should invalidate the cache.
    const absent = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: { skillIds: ["skill-refunds"] },
    });
    const empty = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: { skillIds: ["skill-refunds"], versionPins: [] },
    });
    expect(empty).toBe(absent);
  });

  it("still distinguishes everything it distinguished before", () => {
    const base = buildEnvironmentSelectionKey({
      ...BASE,
      skillSelection: null,
    });
    expect(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        composeMode: true,
      }),
    ).not.toBe(base);
    expect(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        hostIds: ["host-2"],
      }),
    ).not.toBe(base);
    expect(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        serverAttachmentId: "att-1",
      }),
    ).not.toBe(base);
    expect(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        computerEnvironmentId: "img-1",
      }),
    ).not.toBe(base);
    expect(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        customized: true,
      }),
    ).not.toBe(base);
    // Host ids are a SET; their order must not invalidate the cache.
    expect(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        hostIds: ["host-1", "host-2"],
      }),
    ).toBe(
      buildEnvironmentSelectionKey({
        ...BASE,
        skillSelection: null,
        hostIds: ["host-2", "host-1"],
      }),
    );
  });
});
