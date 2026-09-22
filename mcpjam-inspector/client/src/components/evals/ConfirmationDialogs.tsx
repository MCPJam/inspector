import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { EvalSuite } from "./types";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "./constants";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";

const SKIP_DELETE_TEST_CASE_CONFIRMATION_KEY = "skipDeleteTestCaseConfirmation";

interface ConfirmationDialogsProps {
  // Suite deletion
  suiteToDelete: EvalSuite | null;
  setSuiteToDelete: (suite: EvalSuite | null) => void;
  deletingSuiteId: string | null;
  onConfirmDeleteSuite: () => void;

  // Run deletion
  runToDelete: string | null;
  setRunToDelete: (runId: string | null) => void;
  deletingRunId: string | null;
  onConfirmDeleteRun: () => void;

  // Test case deletion
  testCaseToDelete: { id: string; title: string } | null;
  setTestCaseToDelete: (testCase: { id: string; title: string } | null) => void;
  deletingTestCaseId: string | null;
  onConfirmDeleteTestCase: () => void;
}

export function ConfirmationDialogs({
  suiteToDelete,
  setSuiteToDelete,
  deletingSuiteId,
  onConfirmDeleteSuite,
  runToDelete,
  setRunToDelete,
  deletingRunId,
  onConfirmDeleteRun,
  testCaseToDelete,
  setTestCaseToDelete,
  deletingTestCaseId,
  onConfirmDeleteTestCase,
}: ConfirmationDialogsProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  /**
   * A CI-owned suite is deletable — removing a row is not editing what CI
   * runs — but the two things a person cannot see before clicking belong
   * here rather than in a refusal: the runs go with it, and the suite comes
   * BACK on the next report, under a new id, because the SDK reporter
   * identifies a suite by name (issue #5381).
   */
  const deletingCiOwnedSuite = isCiOwnedSuite(suiteToDelete);

  // Auto-confirm test case deletion if user chose to skip confirmation
  useEffect(() => {
    if (testCaseToDelete) {
      const shouldSkip =
        localStorage.getItem(SKIP_DELETE_TEST_CASE_CONFIRMATION_KEY) === "true";
      if (shouldSkip) {
        onConfirmDeleteTestCase();
      }
    }
  }, [testCaseToDelete, onConfirmDeleteTestCase]);

  const handleConfirmDeleteTestCase = () => {
    if (dontShowAgain) {
      localStorage.setItem(SKIP_DELETE_TEST_CASE_CONFIRMATION_KEY, "true");
    }
    onConfirmDeleteTestCase();
  };

  // Don't render test case dialog if user chose to skip
  const shouldSkipTestCaseConfirmation =
    localStorage.getItem(SKIP_DELETE_TEST_CASE_CONFIRMATION_KEY) === "true";

  return (
    <>
      {/* Delete Suite Confirmation Modal */}
      <Dialog
        open={!!suiteToDelete}
        onOpenChange={(open) => !open && setSuiteToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Test Suite
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the test suite?
              <br />
              <br />
              {deletingCiOwnedSuite
                ? "This suite is managed by CI. Deleting it removes the run history stored here; the next CI run or SDK report creates the suite again."
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSuiteToDelete(null)}
              disabled={!!deletingSuiteId}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              onClick={onConfirmDeleteSuite}
              disabled={!!deletingSuiteId}
            >
              {deletingSuiteId ? "Deleting..." : "Delete Suite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Run Confirmation Modal */}
      <Dialog
        open={!!runToDelete}
        onOpenChange={(open) => !open && setRunToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Run
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this run?
              <br />
              <br />
              This will permanently delete all iterations and results associated
              with this run. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRunToDelete(null)}
              disabled={!!deletingRunId}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              onClick={onConfirmDeleteRun}
              disabled={!!deletingRunId}
            >
              {deletingRunId ? "Deleting..." : "Delete Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Test Case Confirmation Modal */}
      {!shouldSkipTestCaseConfirmation && (
        <Dialog
          open={!!testCaseToDelete}
          onOpenChange={(open) => !open && setTestCaseToDelete(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                Delete Test Case
              </DialogTitle>
              <DialogDescription>
                Are you sure you want to delete the test case?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-row items-center sm:justify-between">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="dont-show-delete-test-case"
                  checked={dontShowAgain}
                  onCheckedChange={(checked) =>
                    setDontShowAgain(checked === true)
                  }
                />
                <Label
                  htmlFor="dont-show-delete-test-case"
                  className="text-sm text-muted-foreground cursor-pointer"
                >
                  Do not show this again
                </Label>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setTestCaseToDelete(null)}
                  disabled={!!deletingTestCaseId}
                >
                  Cancel
                </Button>
                <Button
                  className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
                  onClick={handleConfirmDeleteTestCase}
                  disabled={!!deletingTestCaseId}
                >
                  {deletingTestCaseId ? "Deleting..." : "Delete Test Case"}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
