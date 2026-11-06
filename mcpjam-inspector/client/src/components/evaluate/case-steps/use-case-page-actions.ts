/**
 * What the editor's page buttons do: open other pages, Save case, Run (through
 * the Setup Run sheet), Delete and Export. Runs and deletes go through the
 * page services; nothing here calls EvaluateTab directly.
 */
import { useState } from "react";
import { toast } from "sonner";
import type { CaseRunLaunchOptions, EvalSuite } from "@/components/evals/types";
import type { EvalRoute, SuiteSettingsTab } from "@/lib/eval-route-types";
import { normalizeDraftEvalCaseForExport } from "@/lib/evals/eval-export";
import { buildCaseSavePayload } from "@/components/evals/case-save-payload";
import { stepsToPromptTurns } from "@/shared/steps";
import type { EvalNavNames } from "../nav/eval-nav-crumbs";
import { useEvalNavPageServices } from "../nav/eval-nav-page-services";
import { useEvalNavigate } from "../nav/eval-nav-state";
import type { useCaseStepsDraft } from "./use-case-steps-draft";

type CaseRoute = Extract<
  EvalRoute,
  { type: "case-new" | "case-settings" | "test-run-edit" | "case-evaluators" }
>;

export function useCasePageActions({
  route,
  names,
  data,
}: {
  route: CaseRoute;
  names: EvalNavNames;
  data: ReturnType<typeof useCaseStepsDraft>;
}) {
  const services = useEvalNavPageServices();
  const navigate = useEvalNavigate();
  const from = { route, names };
  const { suiteId } = route;
  const testCaseId = data.testCase?._id ?? null;
  const [runOpen, setRunOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const openSuiteSettings = (tab: SuiteSettingsTab) =>
    navigate({ type: "suite-settings", suiteId, tab }, { via: "link", from });

  const openEvaluators = () =>
    testCaseId &&
    navigate(
      { type: "case-evaluators", suiteId, testCaseId },
      { via: "link", from },
    );

  const saveCase = async () => {
    const result = await data.save();
    if (result.ok && route.type === "case-new") {
      navigate(
        { type: "suite-settings", suiteId, tab: "cases" },
        { via: "link", from, replace: true },
      );
    }
  };

  const startRun = async (
    suite: EvalSuite,
    options: CaseRunLaunchOptions & { iterationOverride: number },
  ) => {
    if (!testCaseId) return;
    const skipJudge =
      data.draft?.judgeConfigOverride?.goalCompletion?.enabled === false;
    const launch = await services.runCase(suite, testCaseId, {
      ...options,
      skipJudge,
    });
    const runId = launch?.runIds[0];
    if (!runId) return;
    toast.success("Test run started", {
      action: {
        label: "Open test run",
        onClick: () =>
          navigate(
            { type: "test-run", suiteId, runId, testCaseId },
            { via: "link", from },
          ),
      },
    });
  };

  const confirmDelete = async () => {
    if (!testCaseId || deleting) return;
    setDeleting(true);
    try {
      await services.deleteTestCase(testCaseId);
      toast.success("Test case deleted");
      setDeleteOpen(false);
      navigate(
        route.type === "test-run-edit"
          ? { type: "run-detail", suiteId, runId: route.runId }
          : { type: "suite-settings", suiteId, tab: "cases" },
        { via: "link", replace: true },
      );
    } catch {
      // The batch delete logs the failure; the toast says what to retry.
      toast.error("Could not delete the test case. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  const exportCases = () => {
    const draft = data.draft;
    if (!draft) return [];
    const payload = buildCaseSavePayload(draft, {
      isNegativeTest: draft.toolsChoice === "noTool",
    });
    return [
      normalizeDraftEvalCaseForExport({
        testCaseId,
        title: payload.title,
        query: payload.query,
        runs: payload.runs,
        expectedToolCalls: payload.expectedToolCalls,
        expectedOutput: payload.expectedOutput,
        steps: payload.steps,
        promptTurns: stepsToPromptTurns(payload.steps),
        isNegativeTest: payload.isNegativeTest,
        advancedConfig: payload.advancedConfig,
        scenario: payload.scenario,
      }),
    ];
  };

  return {
    services,
    openSuiteSettings,
    openEvaluators,
    saveCase,
    run: { open: runOpen, setOpen: setRunOpen, start: startRun },
    remove: {
      open: deleteOpen,
      setOpen: setDeleteOpen,
      deleting,
      confirm: confirmDelete,
    },
    exporting: { open: exportOpen, setOpen: setExportOpen, cases: exportCases },
  };
}
