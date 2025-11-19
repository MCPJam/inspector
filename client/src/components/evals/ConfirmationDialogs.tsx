import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EvalSuite } from "./types";

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
              variant="destructive"
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
              variant="destructive"
              onClick={onConfirmDeleteRun}
              disabled={!!deletingRunId}
            >
              {deletingRunId ? "Deleting..." : "Delete Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Test Case Confirmation Modal */}
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
              <br />
              <br />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTestCaseToDelete(null)}
              disabled={!!deletingTestCaseId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onConfirmDeleteTestCase}
              disabled={!!deletingTestCaseId}
            >
              {deletingTestCaseId ? "Deleting..." : "Delete Test Case"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
