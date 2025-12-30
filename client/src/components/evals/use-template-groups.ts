import { useMemo } from "react";
import { EvalCase, EvalIteration, SuiteDetailsQueryResponse } from "./types";
import { computeIterationSummary, getTemplateKey } from "./helpers";

export interface CaseGroup {
  testCase: EvalCase | null;
  iterations: EvalIteration[];
  summary: {
    runs: number;
    passed: number;
    failed: number;
    cancelled: number;
    pending: number;
    tokens: number;
    avgDuration: number | null;
  };
}

export interface TemplateGroup {
  title: string;
  query: string;
  testCaseIds: string[];
  iterations: EvalIteration[];
  summary: {
    runs: number;
    passed: number;
    failed: number;
    cancelled: number;
    pending: number;
    tokens: number;
    avgDuration: number | null;
  };
}

/**
 * Custom hook to compute case groups and template groups from suite details
 */
export function useTemplateGroups(
  suiteDetails: SuiteDetailsQueryResponse | undefined,
  enabled: boolean = true,
): { caseGroups: CaseGroup[]; templateGroups: TemplateGroup[] } {
  const caseGroups = useMemo(() => {
    if (!suiteDetails || !enabled) return [];

    const sortedIterations = [...suiteDetails.iterations].sort(
      (a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt),
    );

    const groups = new Map<string, CaseGroup>();

    // Initialize groups for existing test cases
    suiteDetails.testCases.forEach((testCase) => {
      groups.set(testCase._id, {
        testCase,
        iterations: [],
        summary: {
          runs: 0,
          passed: 0,
          failed: 0,
          cancelled: 0,
          pending: 0,
          tokens: 0,
          avgDuration: null,
        },
      });
    });

    // Process iterations
    // Priority: testCaseId first, then fall back to snapshot grouping
    sortedIterations.forEach((iteration) => {
      if (iteration.testCaseId) {
        // First, try to match by testCaseId (most reliable)
        const group = groups.get(iteration.testCaseId);
        if (group) {
          group.iterations.push(iteration);
        }
      } else if (iteration.testCaseSnapshot) {
        // Fall back to snapshot grouping for legacy iterations without testCaseId
        // (for deleted test cases or old data)
        const snapshotKey = `snapshot-${iteration.testCaseSnapshot.title}-${iteration.testCaseSnapshot.query}`;
        if (!groups.has(snapshotKey)) {
          const virtualTestCase: EvalCase = {
            _id: snapshotKey,
            evalTestSuiteId: suiteDetails.testCases[0]?.evalTestSuiteId || "",
            createdBy: iteration.createdBy || "",
            title: iteration.testCaseSnapshot.title,
            query: iteration.testCaseSnapshot.query,
            provider: iteration.testCaseSnapshot.provider,
            model: iteration.testCaseSnapshot.model,
            expectedToolCalls: iteration.testCaseSnapshot.expectedToolCalls,
          };
          groups.set(snapshotKey, {
            testCase: virtualTestCase,
            iterations: [],
            summary: {
              runs: 0,
              passed: 0,
              failed: 0,
              cancelled: 0,
              pending: 0,
              tokens: 0,
              avgDuration: null,
            },
          });
        }
        groups.get(snapshotKey)!.iterations.push(iteration);
      }
    });

    // Filter groups with iterations and compute summaries
    return Array.from(groups.values())
      .filter((group) => group.iterations.length > 0)
      .map((group) => ({
        ...group,
        iterations: [...group.iterations].sort((a, b) => {
          if (a.iterationNumber != null && b.iterationNumber != null) {
            return a.iterationNumber - b.iterationNumber;
          }
          return (a.createdAt ?? 0) - (b.createdAt ?? 0);
        }),
        summary: computeIterationSummary(group.iterations),
      }));
  }, [suiteDetails, enabled]);

  const templateGroups = useMemo(() => {
    if (!enabled || caseGroups.length === 0) return [];

    const groups = new Map<string, TemplateGroup>();

    caseGroups.forEach((group) => {
      if (!group.testCase) return;

      const templateKey = getTemplateKey(group.testCase);

      if (!groups.has(templateKey)) {
        groups.set(templateKey, {
          title: group.testCase.title,
          query: group.testCase.query,
          testCaseIds: [],
          iterations: [],
          summary: {
            runs: 0,
            passed: 0,
            failed: 0,
            cancelled: 0,
            pending: 0,
            tokens: 0,
            avgDuration: null,
          },
        });
      }

      const templateGroup = groups.get(templateKey)!;
      templateGroup.testCaseIds.push(group.testCase._id);
      templateGroup.iterations.push(...group.iterations);
    });

    return Array.from(groups.values()).map((group) => ({
      ...group,
      summary: computeIterationSummary(group.iterations),
    }));
  }, [caseGroups, enabled]);

  return { caseGroups, templateGroups };
}

/**
 * Hook to compute unique template groups count from suite config
 */
export function useTemplateGroupsCount(
  config: { tests?: any[] } | undefined,
): number {
  return useMemo(() => {
    const tests = config?.tests || [];
    if (tests.length === 0) return 0;

    const templateKeys = new Set<string>();
    tests.forEach((test: any) => {
      const templateKey = getTemplateKey(test);
      templateKeys.add(templateKey);
    });

    return templateKeys.size;
  }, [config]);
}
