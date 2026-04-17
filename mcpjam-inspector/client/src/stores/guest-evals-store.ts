import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
} from "@/components/evals/types";

export const GUEST_USER_ID = "__guest__";

/**
 * Build a URL-safe suite id for the guest store. Server names can contain
 * colons, spaces, parentheses, etc. which the browser URL-encodes in the
 * hash — keeping the id free of those characters avoids a redirect loop
 * where `route.suiteId` (decoded by the router) doesn't match the suite id
 * we store (see `getPlaygroundCasesRedirect`).
 */
function guestSuiteId(serverName: string): string {
  const safe = serverName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `guestsuite-${safe}`;
}

function makeIdSuffix(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/[^A-Za-z0-9]/g, "");
  }
  return `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function now(): number {
  return Date.now();
}

type ServerBucket = {
  suite: EvalSuite;
  testCases: EvalCase[];
  iterations: EvalIteration[];
};

interface GuestEvalsStoreState {
  serverBuckets: Record<string, ServerBucket>;
  ensureSuite: (serverName: string) => EvalSuite;
  getSuite: (serverName: string) => EvalSuite | null;
  getSuiteById: (suiteId: string) => EvalSuite | null;
  getBucketBySuiteId: (suiteId: string) => ServerBucket | null;
  listTestCases: (suiteId: string) => EvalCase[];
  createTestCase: (input: {
    suiteId: string;
    title: string;
    query: string;
    models: Array<{ model: string; provider: string }>;
    expectedToolCalls?: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }>;
    runs?: number;
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    promptTurns?: EvalCase["promptTurns"];
    advancedConfig?: Record<string, unknown>;
  }) => EvalCase | null;
  updateTestCase: (testCaseId: string, updates: Partial<EvalCase>) => void;
  deleteTestCase: (testCaseId: string) => void;
  duplicateTestCase: (testCaseId: string) => EvalCase | null;
  addIteration: (iteration: EvalIteration) => void;
  updateIteration: (
    iterationId: string,
    updates: Partial<EvalIteration>,
  ) => void;
  deleteIteration: (iterationId: string) => void;
  setLastMessageRun: (testCaseId: string, iterationId: string | null) => void;
}

function makeId(prefix: string): string {
  return `guest${prefix}-${makeIdSuffix()}`;
}

function findBucketByTestCaseId(
  state: GuestEvalsStoreState,
  testCaseId: string,
): [string, ServerBucket] | null {
  for (const [serverName, bucket] of Object.entries(state.serverBuckets)) {
    if (bucket.testCases.some((c) => c._id === testCaseId)) {
      return [serverName, bucket];
    }
  }
  return null;
}

function findBucketByIterationId(
  state: GuestEvalsStoreState,
  iterationId: string,
): [string, ServerBucket] | null {
  for (const [serverName, bucket] of Object.entries(state.serverBuckets)) {
    if (bucket.iterations.some((i) => i._id === iterationId)) {
      return [serverName, bucket];
    }
  }
  return null;
}

export const useGuestEvalsStore = create<GuestEvalsStoreState>()(
  persist(
    (set, get) => ({
      serverBuckets: {},

      ensureSuite: (serverName) => {
        const existing = get().serverBuckets[serverName];
        if (existing) {
          return existing.suite;
        }
        const suite: EvalSuite = {
          _id: guestSuiteId(serverName),
          createdBy: GUEST_USER_ID,
          name: serverName,
          description: `Explore cases for ${serverName}`,
          configRevision: "",
          environment: { servers: [serverName] },
          createdAt: now(),
          updatedAt: now(),
          source: "ui",
          runCounter: 0,
          tags: ["explore"],
        };
        set((state) => ({
          serverBuckets: {
            ...state.serverBuckets,
            [serverName]: {
              suite,
              testCases: [],
              iterations: [],
            },
          },
        }));
        return suite;
      },

      getSuite: (serverName) =>
        get().serverBuckets[serverName]?.suite ?? null,

      getSuiteById: (suiteId) => {
        for (const bucket of Object.values(get().serverBuckets)) {
          if (bucket.suite._id === suiteId) return bucket.suite;
        }
        return null;
      },

      getBucketBySuiteId: (suiteId) => {
        for (const bucket of Object.values(get().serverBuckets)) {
          if (bucket.suite._id === suiteId) return bucket;
        }
        return null;
      },

      listTestCases: (suiteId) => {
        const bucket = get().getBucketBySuiteId(suiteId);
        return bucket?.testCases ?? [];
      },

      createTestCase: (input) => {
        const state = get();
        let matchedServer: string | null = null;
        for (const [serverName, bucket] of Object.entries(state.serverBuckets)) {
          if (bucket.suite._id === input.suiteId) {
            matchedServer = serverName;
            break;
          }
        }
        if (!matchedServer) return null;

        const testCase: EvalCase = {
          _id: makeId("case"),
          testSuiteId: input.suiteId,
          createdBy: GUEST_USER_ID,
          title: input.title,
          query: input.query,
          models: input.models,
          runs: input.runs ?? 1,
          expectedToolCalls: (input.expectedToolCalls ?? []) as EvalCase["expectedToolCalls"],
          isNegativeTest: input.isNegativeTest,
          scenario: input.scenario,
          expectedOutput: input.expectedOutput,
          promptTurns: input.promptTurns,
          advancedConfig: input.advancedConfig,
          _creationTime: now(),
        };

        set((current) => {
          const bucket = current.serverBuckets[matchedServer!]!;
          return {
            serverBuckets: {
              ...current.serverBuckets,
              [matchedServer!]: {
                ...bucket,
                suite: { ...bucket.suite, updatedAt: now() },
                testCases: [...bucket.testCases, testCase],
              },
            },
          };
        });

        return testCase;
      },

      updateTestCase: (testCaseId, updates) => {
        const match = findBucketByTestCaseId(get(), testCaseId);
        if (!match) return;
        const [serverName, bucket] = match;
        set((current) => ({
          serverBuckets: {
            ...current.serverBuckets,
            [serverName]: {
              ...bucket,
              suite: { ...bucket.suite, updatedAt: now() },
              testCases: bucket.testCases.map((c) =>
                c._id === testCaseId ? { ...c, ...updates } : c,
              ),
            },
          },
        }));
      },

      deleteTestCase: (testCaseId) => {
        const match = findBucketByTestCaseId(get(), testCaseId);
        if (!match) return;
        const [serverName, bucket] = match;
        set((current) => ({
          serverBuckets: {
            ...current.serverBuckets,
            [serverName]: {
              ...bucket,
              suite: { ...bucket.suite, updatedAt: now() },
              testCases: bucket.testCases.filter((c) => c._id !== testCaseId),
              iterations: bucket.iterations.filter(
                (i) => i.testCaseId !== testCaseId,
              ),
            },
          },
        }));
      },

      duplicateTestCase: (testCaseId) => {
        const state = get();
        const match = findBucketByTestCaseId(state, testCaseId);
        if (!match) return null;
        const [serverName, bucket] = match;
        const source = bucket.testCases.find((c) => c._id === testCaseId);
        if (!source) return null;

        const copy: EvalCase = {
          ...source,
          _id: makeId("case"),
          title: `${source.title} (copy)`,
          _creationTime: now(),
          lastMessageRun: null,
        };

        set((current) => {
          const currentBucket = current.serverBuckets[serverName]!;
          return {
            serverBuckets: {
              ...current.serverBuckets,
              [serverName]: {
                ...currentBucket,
                suite: { ...currentBucket.suite, updatedAt: now() },
                testCases: [...currentBucket.testCases, copy],
              },
            },
          };
        });

        return copy;
      },

      addIteration: (iteration) => {
        if (!iteration.testCaseId) return;
        const match = findBucketByTestCaseId(get(), iteration.testCaseId);
        if (!match) return;
        const [serverName, bucket] = match;
        set((current) => ({
          serverBuckets: {
            ...current.serverBuckets,
            [serverName]: {
              ...bucket,
              iterations: [iteration, ...bucket.iterations],
            },
          },
        }));
      },

      updateIteration: (iterationId, updates) => {
        const match = findBucketByIterationId(get(), iterationId);
        if (!match) return;
        const [serverName, bucket] = match;
        set((current) => ({
          serverBuckets: {
            ...current.serverBuckets,
            [serverName]: {
              ...bucket,
              iterations: bucket.iterations.map((i) =>
                i._id === iterationId ? { ...i, ...updates } : i,
              ),
            },
          },
        }));
      },

      deleteIteration: (iterationId) => {
        const match = findBucketByIterationId(get(), iterationId);
        if (!match) return;
        const [serverName, bucket] = match;
        set((current) => ({
          serverBuckets: {
            ...current.serverBuckets,
            [serverName]: {
              ...bucket,
              iterations: bucket.iterations.filter(
                (i) => i._id !== iterationId,
              ),
            },
          },
        }));
      },

      setLastMessageRun: (testCaseId, iterationId) => {
        const match = findBucketByTestCaseId(get(), testCaseId);
        if (!match) return;
        const [serverName, bucket] = match;
        set((current) => ({
          serverBuckets: {
            ...current.serverBuckets,
            [serverName]: {
              ...bucket,
              testCases: bucket.testCases.map((c) =>
                c._id === testCaseId
                  ? { ...c, lastMessageRun: iterationId }
                  : c,
              ),
            },
          },
        }));
      },
    }),
    {
      // v2: ID format changed from `guest:suite:…`/`guest:case:…` to
      // URL-safe hyphen form. Old persisted data is abandoned on upgrade so
      // stale colon-containing IDs don't re-trigger the router redirect loop.
      name: "mcpjam_guest_evals_v2",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ serverBuckets: state.serverBuckets }),
    },
  ),
);
