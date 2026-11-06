import { useMemo } from "react";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { draftTestCaseId } from "@/components/evals/draft-test-case";
import { CI_OWNED_REASON_COPY } from "@/components/evals/capability-reasons";
import type { EvalRoute } from "@/lib/eval-route-types";
import { useEvalNavPageServices } from "../nav/eval-nav-page-services";
import type { EvalNavNames } from "../nav/eval-nav-crumbs";
import { useEvalNavigate } from "../nav/eval-nav-state";
import { buildSuiteTestCaseRows } from "../suite-detail-model";
import { SuiteCasesCard } from "./suite-cases-card";
import { suiteGenerateState } from "./suite-generate-state";
import { useSuiteCaseAuthoring } from "./use-suite-case-authoring";
import { buildCopyTargets, useCopyTestCase } from "./use-copy-test-case";

/** Test cases: the case card, its takeovers, Add case, copy and delete. */
export function SuiteCasesTab({
  route,
  names,
  suite,
  cases,
  projectSuites,
  projectId,
  locked,
  onClearImportJob,
}: {
  route: Extract<EvalRoute, { type: "suite-settings" }>;
  names: EvalNavNames;
  suite: EvalSuite;
  cases: EvalCase[];
  projectSuites: EvalSuite[];
  projectId: string | null;
  /** CI-owned or read-only: no authoring, delete and copy stay. */
  locked: boolean;
  /** Back to the plain cases address, keeping the arrival state. */
  onClearImportJob(): void;
}) {
  const services = useEvalNavPageServices();
  const navigate = useEvalNavigate();
  const from = { route, names };
  const open = (to: EvalRoute) => navigate(to, { via: "link", from });
  const generate = suiteGenerateState(
    suite,
    services.connectedServerNames,
    Boolean(services.ensureServersReady),
  );
  const authoring = useSuiteCaseAuthoring({
    suite,
    projectId,
    locked,
    importJobId: route.importJob ?? null,
    onClearImportJob,
    onDescribe: () => open({ type: "case-new", suiteId: suite._id }),
    onAddManually: () =>
      open({
        type: "test-edit",
        suiteId: suite._id,
        testId: draftTestCaseId("prompt"),
      }),
    canGenerate: generate.canGenerate,
    generateDisabledReason: generate.disabledReason,
  });
  const copy = useCopyTestCase({
    onOpenCopy: ({ suiteId, testCaseId }) =>
      open({ type: "case-settings", suiteId, testCaseId }),
  });
  const rows = useMemo(() => buildSuiteTestCaseRows(cases), [cases]);
  const copyTargets = useMemo(
    () =>
      services.isDirectGuest
        ? null
        : buildCopyTargets(projectSuites, suite._id),
    [services.isDirectGuest, projectSuites, suite._id],
  );

  return (
    <>
      {authoring.dialogs}
      {authoring.takeover ??
        (rows.length === 0 ? (
          authoring.emptyHero
        ) : (
          <SuiteCasesCard
            cases={rows}
            addCaseItems={authoring.addCaseItems}
            generateDisabledReason={generate.disabledReason}
            lockedReason={locked ? CI_OWNED_REASON_COPY : undefined}
            headerExtra={authoring.reviewDraftsButton}
            copyTargets={copyTargets}
            pendingCopyCaseId={copy.pendingCaseId}
            canDelete
            onOpenCase={(caseId) =>
              open({
                type: "case-settings",
                suiteId: suite._id,
                testCaseId: caseId,
              })
            }
            onCopy={(caseId, target) => {
              const row = rows.find((candidate) => candidate.caseId === caseId);
              if (row) void copy.copy(row, target);
            }}
            onDelete={(caseId) => services.deleteTestCase(caseId)}
          />
        ))}
    </>
  );
}
