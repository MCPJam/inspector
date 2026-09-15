/** Frozen before execution. Excluded cases never become fabricated iterations. */
export interface EvalSelectionManifest {
  schemaVersion: 1;
  sourceSuite: string;
  sourceCaseIds: string[];
  selectedCaseIds: string[];
  cases: Array<{
    caseId: string;
    plannedIterations: number;
    excludedReason?: "not_selected";
  }>;
  sourceConfigHash: string;
  selectedConfigHash: string;
  scope: "full" | "selected";
}
