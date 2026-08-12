/**
 * The session draft is the only thing standing between a remount and a thrown
 * away persona slate, so the cases that matter are the ones where it must
 * REFUSE to resume: another project, another version, an expired write, or a
 * payload whose shape the launch would write from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNewSwarmFlowDraft,
  readNewSwarmFlowDraft,
  saveNewSwarmFlowDraft,
  type NewSwarmFlowDraft,
} from "../new-swarm-flow-draft";

const STORAGE_KEY = "mcp-new-swarm-flow-draft";

function draft(overrides: Partial<NewSwarmFlowDraft> = {}): NewSwarmFlowDraft {
  return {
    step: "confirm",
    description: "Support agents answering refunds",
    targetState: {
      environmentIds: ["env-1"],
      stack: {
        hostIds: [],
        serverAttachmentId: null,
        skillSelection: null,
        computerEnvironmentId: null,
      },
      customized: false,
    },
    resolvedEnvironmentIds: ["env-1"],
    resolvedEnvironments: null,
    createdEnvOverlay: [],
    pushIntensity: "quick",
    reusedIds: [],
    proposed: [
      {
        key: "persona-0-Refund Chaser",
        name: "Refund Chaser",
        role: "Support agent",
        avatarShape: 1,
        avatarPalette: 2,
        journeys: [{ key: "journey-0-0", goal: "Refund the charge" }],
      },
    ],
    launchedRuns: [],
    runLabels: [],
    generatingSince: null,
    launch: {
      flowId: "flow-1",
      swarmId: null,
      runGroupId: null,
      targets: null,
      environmentKey: "castles|env-1",
    },
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("new swarm flow draft", () => {
  it("round-trips the resumable flow for the same project", () => {
    saveNewSwarmFlowDraft("proj-1", draft());

    expect(readNewSwarmFlowDraft("proj-1")).toEqual(draft());
  });

  it("reads through repeated remounts — reading is not consuming", () => {
    saveNewSwarmFlowDraft("proj-1", draft());

    expect(readNewSwarmFlowDraft("proj-1")).not.toBeNull();
    expect(readNewSwarmFlowDraft("proj-1")).not.toBeNull();
  });

  it("keeps the launch identity so a retry cannot double-create rows", () => {
    saveNewSwarmFlowDraft(
      "proj-1",
      draft({
        launch: {
          flowId: "flow-1",
          swarmId: "swarm-1",
          runGroupId: "wave-1",
          targets: [
            {
              journeyId: "journey-1",
              label: "Refund a charge",
              personaId: "persona-1",
              personaName: "Refund Chaser",
              personaRole: "Support agent",
            },
          ],
          environmentKey: "castles|env-1",
        },
      })
    );

    const restored = readNewSwarmFlowDraft("proj-1");
    expect(restored?.launch).toMatchObject({
      flowId: "flow-1",
      swarmId: "swarm-1",
      runGroupId: "wave-1",
      environmentKey: "castles|env-1",
    });
    expect(restored?.launch.targets).toHaveLength(1);
  });

  it("does not resume another project's flow", () => {
    saveNewSwarmFlowDraft("proj-1", draft());

    expect(readNewSwarmFlowDraft("proj-2")).toBeNull();
  });

  it("ignores a blank project id on both ends", () => {
    saveNewSwarmFlowDraft("   ", draft());
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(readNewSwarmFlowDraft(null)).toBeNull();
    expect(readNewSwarmFlowDraft(undefined)).toBeNull();
  });

  it("expires a draft left behind in a long-lived tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    saveNewSwarmFlowDraft("proj-1", draft());

    vi.setSystemTime(new Date("2026-01-01T03:59:00Z"));
    expect(readNewSwarmFlowDraft("proj-1")).not.toBeNull();

    vi.setSystemTime(new Date("2026-01-01T04:01:00Z"));
    expect(readNewSwarmFlowDraft("proj-1")).toBeNull();
  });

  it("refuses a draft written by another version", () => {
    saveNewSwarmFlowDraft("proj-1", draft());
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored, version: 99 })
    );

    expect(readNewSwarmFlowDraft("proj-1")).toBeNull();
  });

  it("refuses garbage rather than resuming a half-shaped flow", () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");
    expect(readNewSwarmFlowDraft("proj-1")).toBeNull();

    // A proposal without its stable key would create a nameless persona at
    // launch — the one field the flow WRITES from, so it is validated.
    saveNewSwarmFlowDraft("proj-1", draft());
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...stored,
        draft: { ...stored.draft, proposed: [{ name: "Nameless" }] },
      })
    );
    expect(readNewSwarmFlowDraft("proj-1")).toBeNull();
  });

  it("refuses an unknown step", () => {
    saveNewSwarmFlowDraft("proj-1", draft());
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored, draft: { ...stored.draft, step: "findings" } })
    );

    expect(readNewSwarmFlowDraft("proj-1")).toBeNull();
  });

  it("clear removes the draft", () => {
    saveNewSwarmFlowDraft("proj-1", draft());
    clearNewSwarmFlowDraft();

    expect(readNewSwarmFlowDraft("proj-1")).toBeNull();
  });
});
