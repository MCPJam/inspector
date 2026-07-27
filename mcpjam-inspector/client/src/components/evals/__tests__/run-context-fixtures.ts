/**
 * Shared run fixtures for the Phase 3 run-identity tests. Lives outside the
 * spec files because the flag-ON and flag-OFF (kill-switch) suites must assert
 * against IDENTICAL data — the only difference between them is the mocked
 * `project-environments-enabled` value.
 */
import type { EvalSuite, EvalSuiteRun } from "../types";

export function envRun(
  id: string,
  environmentId: string,
  name: string,
  revision: number,
  overrides: Partial<EvalSuiteRun> = {}
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      // NOTE: `environment.servers` is the unrelated legacy server-name bag —
      // it must never be read as environment identity.
      environment: { servers: ["server-1"] },
      environmentRef: { environmentId, name, revision },
    },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    completedAt: 2_000,
    summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
    ...overrides,
  } as EvalSuiteRun;
}

export function hostRun(
  id: string,
  namedHostId: string | undefined,
  overrides: Partial<EvalSuiteRun> = {}
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: ["server-1"] } },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    completedAt: 2_000,
    summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
    ...(namedHostId ? { namedHostId } : {}),
    ...overrides,
  } as EvalSuiteRun;
}

export const contextSuite: EvalSuite = {
  _id: "suite-1",
  createdBy: "user-1",
  name: "Suite",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
} as EvalSuite;

/**
 * One environment, three runs in a single launch group — the shape that made
 * a row-count header claim "3 environments". Spans revisions 2→4 so a group
 * header must summarise a RANGE, never one arbitrary revision.
 */
export const oneEnvironmentThreeRuns: EvalSuiteRun[] = [
  envRun("oneenv01", "env-a", "Staging", 2, {
    runGroupId: "g-one",
    createdAt: 20_000,
    completedAt: 21_000,
  }),
  envRun("oneenv02", "env-a", "Staging", 3, {
    runGroupId: "g-one",
    createdAt: 20_100,
    completedAt: 21_100,
  }),
  envRun("oneenv03", "env-a", "Staging", 4, {
    runGroupId: "g-one",
    createdAt: 20_200,
    completedAt: 21_200,
  }),
];

/** Two distinct environments in one launch group. */
export const twoEnvironmentsOneGroup: EvalSuiteRun[] = [
  envRun("twoenv01", "env-a", "Staging", 2, {
    runGroupId: "g-two",
    createdAt: 20_000,
    completedAt: 21_000,
  }),
  envRun("twoenv02", "env-b", "Prod", 7, {
    runGroupId: "g-two",
    createdAt: 20_100,
    completedAt: 21_100,
  }),
];
