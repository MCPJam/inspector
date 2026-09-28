import { describe, expect, it } from "vitest";
import type { SwarmOverviewRun } from "@/lib/swarm-api";
import {
  DETAIL_TAB_OPTIONS,
  fallbackColumnsFromWave,
  launchedRunsFromWave,
  resolveSwarmRunDetailTab,
} from "../swarm-run-detail-model";

const run = (overrides: Partial<SwarmOverviewRun> = {}): SwarmOverviewRun => ({
  runId: "run-1",
  journeyRefId: "journey-1",
  journeyName: "Refund a charge",
  journeyArchived: false,
  personaName: "Maya Chen",
  createdAt: 1,
  status: "running",
  summary: { total: 2, succeeded: 0, failed: 0, rateLimited: 0 },
  findings: [],
  targets: [
    {
      hostName: "Claude",
      modelId: "anthropic/claude-haiku-4.5",
      environmentName: "Prod · Claude",
    },
  ],
  ...overrides,
});

describe("DETAIL_TAB_OPTIONS", () => {
  /**
   * Findings leads because it is what a reader wants from a settled wave;
   * Run trails because it is the watch surface, reached while a wave is in
   * flight through resolveSwarmRunDetailTab rather than by clicking. Pinned
   * because the order is a product decision, not an implementation detail.
   */
  it("puts Run last, after Findings, Insights and Sessions", () => {
    expect(DETAIL_TAB_OPTIONS.map((tab) => tab.value)).toEqual([
      "findings",
      "insights",
      "sessions",
      "run",
    ]);
  });
});

describe("resolveSwarmRunDetailTab", () => {
  it("opens the watch surface for a live wave with no tab", () => {
    expect(
      resolveSwarmRunDetailTab({
        parsed: "findings",
        tabParam: null,
        sessionParam: null,
        live: true,
      }),
    ).toBe("run");
  });

  it("keeps an explicit Findings tab while the wave is live", () => {
    expect(
      resolveSwarmRunDetailTab({
        parsed: "findings",
        tabParam: "findings",
        sessionParam: null,
        live: true,
      }),
    ).toBe("findings");
  });

  it("keeps a session deep-link on Sessions", () => {
    expect(
      resolveSwarmRunDetailTab({
        parsed: "sessions",
        tabParam: null,
        sessionParam: "thread-1",
        live: true,
      }),
    ).toBe("sessions");
  });

  it("keeps ?tab=run on a settled wave so the matrix stays reachable", () => {
    expect(
      resolveSwarmRunDetailTab({
        parsed: "run",
        tabParam: "run",
        sessionParam: null,
        live: false,
      }),
    ).toBe("run");
  });

  it("defaults a settled wave with no tab to Findings", () => {
    expect(
      resolveSwarmRunDetailTab({
        parsed: "findings",
        tabParam: null,
        sessionParam: null,
        live: false,
      }),
    ).toBe("findings");
  });
});

describe("launchedRunsFromWave", () => {
  it("joins persona docs by name and keeps the goal label", () => {
    const [row] = launchedRunsFromWave(
      [run()],
      [
        {
          _id: "persona-1",
          name: "Maya Chen",
          role: "Ops lead",
          avatarShape: 2,
          avatarPalette: 3,
        },
      ],
    );
    expect(row).toMatchObject({
      runId: "run-1",
      journeyId: "journey-1",
      personaId: "persona-1",
      personaName: "Maya Chen",
      personaRole: "Ops lead",
      avatarShape: 2,
      avatarPalette: 3,
      goalLabel: "Refund a charge",
    });
  });

  it("falls back to the persona name when no doc matches", () => {
    const [row] = launchedRunsFromWave([run()], []);
    expect(row?.personaId).toBe("Maya Chen");
    expect(row?.personaRole).toBe("");
  });
});

describe("fallbackColumnsFromWave", () => {
  it("prefers a matching host id and the environment nickname", () => {
    expect(
      fallbackColumnsFromWave(
        [run()],
        [{ hostId: "host-claude", name: "Claude" }],
      ),
    ).toEqual([
      {
        key: "host-claude",
        hostId: "host-claude",
        label: "Prod · Claude",
      },
    ]);
  });

  it("dedupes the same target across goals", () => {
    const columns = fallbackColumnsFromWave(
      [run(), run({ runId: "run-2", journeyRefId: "journey-2" })],
      [{ hostId: "host-claude", name: "Claude" }],
    );
    expect(columns).toHaveLength(1);
  });
});
