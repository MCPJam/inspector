/**
 * Environment-first run identity (Project Environments, Phase 3).
 *
 * The results surfaces used to key and label every run by `namedHostId`, so
 * two environments resolving to the same host were indistinguishable and an
 * environment run was labelled by its host. These tests pin the replacement
 * semantics:
 *
 *   - the grouping key is the ENVIRONMENT ID, never the revision (an
 *     environment is live-editable, so every edit bumps the revision — keying
 *     on it would shatter a suite's history into singletons);
 *   - the exact revision belongs on an individual RUN row;
 *   - a group header never claims one arbitrary revision;
 *   - legacy runs with no `environmentRef` keep today's host label.
 */
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import {
  buildHostNamesById,
  hasEnvironmentRun,
  runContextKey,
  runContextKeys,
  runContextLabel,
  runContextRevisionSummary,
  runRevisionLabel,
  getEnvironmentConflictMessage,
} from "../helpers";
import { resolveCaseRunBatchHost } from "../runs/group-case-iterations";
import { SuiteRunsList } from "../suite-runs-list";
import { SuiteResultsSplit } from "../suite-results-split";
import { CaseRunsHistory } from "../runs/case-runs-history";
import {
  contextSuite,
  envRun,
  hostRun,
  oneEnvironmentThreeRuns,
} from "./run-context-fixtures";
import type { EvalIteration } from "../types";

// The chips are flag-gated exactly like the run-detail "Environment" row.
// Flag ON is the state under test; the OFF path is asserted separately below
// via the pure helpers, which are never gated.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
  useProjectEnvironmentsEnabledState: () => true,
  PROJECT_ENVIRONMENTS_FEATURE_FLAG: "project-environments-enabled",
}));

describe("runContextKey", () => {
  it("keys an environment run by environment id, NOT by revision", () => {
    const rev1 = envRun("r1", "env-a", "Staging", 1);
    const rev9 = envRun("r2", "env-a", "Staging", 9);
    expect(runContextKey(rev1)).toBe("environment:env-a");
    expect(runContextKey(rev9)).toBe("environment:env-a");
    expect(runContextKey(rev1)).toBe(runContextKey(rev9));
  });

  it("keeps ONE group for one environment across several revisions", () => {
    const runs = [
      envRun("r1", "env-a", "Staging", 1),
      envRun("r2", "env-a", "Staging", 2),
      envRun("r3", "env-a", "Staging", 7),
    ];
    expect(runContextKeys(runs)).toEqual(["environment:env-a"]);
  });

  it("keeps two environments that resolve to the SAME host in SEPARATE groups", () => {
    // Both environments point at host-claude; only the environment id differs.
    const runs = [
      envRun("r1", "env-a", "Staging", 3, { namedHostId: "host-claude" }),
      envRun("r2", "env-b", "Prod", 3, { namedHostId: "host-claude" }),
    ];
    expect(runContextKeys(runs)).toEqual([
      "environment:env-a",
      "environment:env-b",
    ]);
    expect(runContextKeys(runs)).toHaveLength(2);
  });

  it("falls back to namedHostId for legacy runs, and to a stable sentinel with neither", () => {
    expect(runContextKey(hostRun("r1", "host-claude"))).toBe(
      "host:host-claude"
    );
    expect(runContextKey(hostRun("r2", undefined))).toBe("host:none");
  });

  it("does not conflate a host-keyed run with an environment-keyed one", () => {
    expect(runContextKey(hostRun("r1", "host-claude"))).not.toBe(
      runContextKey(envRun("r2", "host-claude", "Staging", 1))
    );
  });
});

describe("buildHostNamesById", () => {
  it("names hosts with no suite attachment from the project host list", () => {
    // An environment-backed suite has no attachments at all, so the project
    // host list is the only source for its resolved host's name.
    const names = buildHostNamesById(undefined, [
      { hostId: "host-claude", name: "Claude" },
    ]);
    expect(names.get("host-claude")).toBe("Claude");
  });

  it("prefers the attachment label, falling back to the project host name", () => {
    const names = buildHostNamesById(
      [
        { namedHostId: "host-claude", hostName: "Claude (suite)" },
        { namedHostId: "host-cursor", hostName: null },
      ],
      [
        { hostId: "host-claude", name: "Claude" },
        { hostId: "host-cursor", name: "Cursor" },
      ],
    );
    expect(names.get("host-claude")).toBe("Claude (suite)");
    expect(names.get("host-cursor")).toBe("Cursor");
  });

  it("keeps a derived display name when an attachment stores the raw name", () => {
    const names = buildHostNamesById(
      [{ namedHostId: "host-cursor", hostName: "Cursor" }],
      [
        {
          hostId: "host-cursor",
          name: "Cursor",
          displayName: "Cursor #2",
        },
      ],
    );

    expect(names.get("host-cursor")).toBe("Cursor #2");
  });
});

describe("runContextLabel / runRevisionLabel", () => {
  it("labels an environment run by its frozen environment name", () => {
    expect(runContextLabel(envRun("r1", "env-a", "Staging", 4))).toBe(
      "Staging"
    );
  });

  it("labels a legacy run by the resolved host name", () => {
    const names = new Map<string, string | null>([["host-claude", "Claude"]]);
    expect(runContextLabel(hostRun("r1", "host-claude"), names)).toBe("Claude");
  });

  it("falls back to a truncated host id when the host name is unresolvable", () => {
    // Unattached / deleted host: not in the map, and a `null` entry must fall
    // through too (Map.get returning null is not "no name available").
    expect(runContextLabel(hostRun("r1", "host-claude-0123456789"))).toBe(
      "host-cla"
    );
    expect(
      runContextLabel(
        hostRun("r1", "host-claude-0123456789"),
        new Map([["host-claude-0123456789", null]])
      )
    ).toBe("host-cla");
  });

  it("returns null when a run names neither an environment nor a host", () => {
    expect(runContextLabel(hostRun("r1", undefined))).toBeNull();
  });

  it("puts the exact revision on the run — and never on a legacy run", () => {
    expect(runRevisionLabel(envRun("r1", "env-a", "Staging", 4))).toBe("rev 4");
    expect(runRevisionLabel(hostRun("r2", "host-claude"))).toBeNull();
  });
});

describe("runContextRevisionSummary (group header)", () => {
  it("never claims one arbitrary revision when the group spans several", () => {
    const summary = runContextRevisionSummary([
      envRun("r1", "env-a", "Staging", 2),
      envRun("r2", "env-a", "Staging", 5),
      envRun("r3", "env-a", "Staging", 7),
    ]);
    expect(summary).toBe("rev 2–7");
    // Explicitly NOT any single member revision.
    expect(summary).not.toBe("rev 2");
    expect(summary).not.toBe("rev 5");
    expect(summary).not.toBe("rev 7");
  });

  it("shows a single revision only when every run agrees", () => {
    expect(
      runContextRevisionSummary([
        envRun("r1", "env-a", "Staging", 3),
        envRun("r2", "env-b", "Prod", 3),
      ])
    ).toBe("rev 3");
  });

  it("is null for a legacy group", () => {
    expect(
      runContextRevisionSummary([
        hostRun("r1", "host-a"),
        hostRun("r2", "host-b"),
      ])
    ).toBeNull();
    expect(hasEnvironmentRun([hostRun("r1", "host-a")])).toBe(false);
    expect(hasEnvironmentRun([envRun("r1", "env-a", "Staging", 1)])).toBe(true);
  });
});

describe("resolveCaseRunBatchHost (case history)", () => {
  const batch = { key: "suite:run-1", iterations: [] as EvalIteration[] };

  it("names an environment batch by the environment + its exact revision", () => {
    const resolved = resolveCaseRunBatchHost(batch, {
      runsById: new Map([["run-1", envRun("run-1", "env-a", "Staging", 6)]]),
    });
    expect(resolved).toEqual({
      hostName: "Staging",
      environmentId: "env-a",
      revisionLabel: "rev 6",
    });
  });

  it("prefers the environment over the host the environment resolved to", () => {
    const resolved = resolveCaseRunBatchHost(batch, {
      runsById: new Map([
        [
          "run-1",
          envRun("run-1", "env-a", "Staging", 6, {
            namedHostId: "host-claude",
          }),
        ],
      ]),
      hostNamesById: new Map([["host-claude", "Claude"]]),
    });
    expect(resolved?.hostName).toBe("Staging");
    expect(resolved?.environmentId).toBe("env-a");
  });

  it("keeps the legacy host label for a run with no environmentRef", () => {
    const resolved = resolveCaseRunBatchHost(batch, {
      runsById: new Map([["run-1", hostRun("run-1", "host-claude")]]),
      hostNamesById: new Map([["host-claude", "Claude"]]),
    });
    expect(resolved).toEqual({ hostId: "host-claude", hostName: "Claude" });
  });

  it("suppresses environment identity when the kill-switch is off", () => {
    const resolved = resolveCaseRunBatchHost(batch, {
      runsById: new Map([
        [
          "run-1",
          envRun("run-1", "env-a", "Staging", 6, {
            namedHostId: "host-claude",
          }),
        ],
      ]),
      hostNamesById: new Map([["host-claude", "Claude"]]),
      projectEnvironmentsEnabled: false,
    });
    expect(resolved).toEqual({ hostId: "host-claude", hostName: "Claude" });
  });
});

describe("SuiteRunsList mixed host/environment history", () => {
  it("renders both, each labelled by its own context", () => {
    renderWithProviders(
      <SuiteRunsList
        runs={[
          envRun("envrun00", "env-a", "Staging", 4, {
            createdAt: 20_000,
            completedAt: 21_000,
          }),
          hostRun("hostrun0", "host-claude", {
            createdAt: 10_000,
            completedAt: 11_000,
          }),
        ]}
        allIterations={[]}
        hostNamesById={new Map([["host-claude", "Claude"]])}
        onRunClick={vi.fn()}
      />
    );

    // Environment run → environment name + its exact revision.
    expect(screen.getByText("Staging")).toBeInTheDocument();
    expect(screen.getByText("rev 4")).toBeInTheDocument();
    // Legacy run → today's host label, unchanged.
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("labels a multi-environment launch group by its axis, claiming no revision", () => {
    renderWithProviders(
      <SuiteRunsList
        runs={[
          envRun("grpa0000", "env-a", "Staging", 2, {
            runGroupId: "g-1",
            createdAt: 20_000,
            completedAt: 21_000,
          }),
          envRun("grpb0000", "env-b", "Prod", 7, {
            runGroupId: "g-1",
            createdAt: 20_100,
            completedAt: 21_100,
          }),
        ]}
        allIterations={[]}
        onRunClick={vi.fn()}
      />
    );

    const header = screen.getByText(/Run group g/i).closest("button");
    expect(header).not.toBeNull();
    // The collapsed group header names the axis only — no revision, and no
    // single environment standing in for the whole group.
    expect(header!.textContent).toContain("2 environments");
    expect(header!.textContent).not.toMatch(/rev \d/);
  });
});

/**
 * The group-header count is a count of CONTEXTS, not of run rows. Re-running
 * one environment (each run pinning a fresh revision, since an environment is
 * live-editable) must stay "1 environment". This is the bug Phase 3 fixed in
 * the rail's `RailGroup.hostCount`; it is pinned on BOTH surfaces here so it
 * cannot be reintroduced in one of them.
 */
describe("CaseRunsHistory environment batch header", () => {
  it("renders the environment name + its exact revision via the shared chip", () => {
    // Same `EnvironmentChip` the results surfaces use, so the two renderings
    // of environment identity cannot drift apart.
    const iterations = [
      {
        _id: "it-1",
        testCaseId: "case-1",
        suiteRunId: "envrun00",
        iterationNumber: 1,
        result: "passed",
        createdAt: 1_000,
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ] as unknown as EvalIteration[];

    renderWithProviders(
      <CaseRunsHistory
        iterations={iterations}
        onSelectIteration={vi.fn()}
        suiteRuns={[envRun("envrun00", "env-a", "Staging", 6)]}
      />
    );

    const chip = screen.getByTitle("Staging · env-a");
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toContain("Staging");
    expect(chip.textContent).toContain("rev 6");
  });
});

describe("group header counts CONTEXTS, not run rows", () => {
  it("runs list: one environment re-run three times reads '1 environment'", () => {
    renderWithProviders(
      <SuiteRunsList
        runs={oneEnvironmentThreeRuns}
        allIterations={[]}
        onRunClick={vi.fn()}
      />
    );

    const header = screen.getByText(/Run group g/i).closest("button");
    expect(header!.textContent).toContain("1 environment");
    expect(header!.textContent).not.toContain("3 environments");
  });

  it("results rail: the same group never claims three environments", () => {
    renderWithProviders(
      <SuiteResultsSplit
        suite={contextSuite}
        cases={[]}
        runs={oneEnvironmentThreeRuns}
        allIterations={[]}
        hostNamesById={new Map()}
        allRunsPane={<div />}
        onTestCaseClick={vi.fn()}
        onRunClick={vi.fn()}
      />
    );

    expect(screen.queryByText(/3 environments/)).not.toBeInTheDocument();
    // One context ⇒ its NAME, plus the RANGE its runs spanned. Never one
    // arbitrary revision.
    expect(screen.getByText("Staging · rev 2–4")).toBeInTheDocument();
    expect(screen.queryByText(/rev 3$/)).not.toBeInTheDocument();
  });
});

describe("getEnvironmentConflictMessage", () => {
  it("recognises the environment-drift 409 and returns its readable message", () => {
    const error = Object.assign(
      new Error("Environment changed — retry the run."),
      {
        code: "ENVIRONMENT_REVISION_CONFLICT",
      }
    );
    expect(getEnvironmentConflictMessage(error)).toBe(
      "Environment changed — retry the run."
    );
  });

  it("ignores unrelated failures", () => {
    expect(getEnvironmentConflictMessage(new Error("boom"))).toBeNull();
    expect(
      getEnvironmentConflictMessage(
        Object.assign(new Error("nope"), { code: "VALIDATION_ERROR" })
      )
    ).toBeNull();
    expect(getEnvironmentConflictMessage(undefined)).toBeNull();
  });
});
