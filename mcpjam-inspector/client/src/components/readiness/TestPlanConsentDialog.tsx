/**
 * Asks before a run from the page makes a saved test plan's calls. Anyone who
 * can save a plan could otherwise turn another member's "Run checks" into
 * calls made with that member's connection to the server, destructive ones
 * included. So the dialog names the revision, who saved it and when, how many
 * tools it calls and which can change or destroy data.
 *
 * Only Cancel and Escape decline: a click outside does not answer, and the
 * page unmounts the dialog once the person has.
 */
import { formatDistanceToNow } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { useTaskOwnerId } from "@/hooks/use-task-owner-id";
import type { TestPlanView } from "@/lib/apis/directory-test-plan-api";

/** "a", "a and b", "a, b and c". */
function listOf(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function TestPlanConsentDialog({
  saved,
  serverName,
  onConfirm,
  onCancel,
}: {
  saved: TestPlanView;
  serverName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const you = useTaskOwnerId();
  const { revision } = saved;
  const called = saved.plan.tools.filter(
    (entry) => entry.action !== "excluded",
  );
  const named = (effect: string) =>
    called.filter((entry) => entry.effect === effect).map(({ tool }) => tool);
  const writes = named("write");
  const destroys = named("destructive");
  const who = saved.savedBy === you ? "you" : "a project member";
  const when = formatDistanceToNow(saved.savedAt, { addSuffix: true });
  const tools = called.length === 1 ? "1 tool" : `${called.length} tools`;
  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent onEscapeKeyDown={onCancel}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {`Run checks with test plan revision ${revision}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {`Revision ${revision} was saved by ${who} ${when}. It calls ${tools} on ${serverName} with your account.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1 text-sm">
          {writes.length > 0 ? (
            <p>{`${listOf(writes)} can change data.`}</p>
          ) : null}
          {destroys.length > 0 ? (
            <p>{`${listOf(destroys)} can destroy data.`}</p>
          ) : null}
          {writes.length + destroys.length === 0 ? (
            <p>None of these tools can change data.</p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {`Run with revision ${revision}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
