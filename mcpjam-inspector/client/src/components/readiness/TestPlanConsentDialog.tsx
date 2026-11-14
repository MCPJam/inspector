/**
 * Asks before a run from the page makes a saved test plan's calls. Anyone who
 * can save a plan could otherwise turn another member's "Run checks" into
 * calls made with that member's connection to the server, destructive ones
 * included. So the dialog names the revision, who saved it and when, and
 * shows every call it makes, in run order, with its exact arguments, then its
 * fixtures, cleanup calls and excluded tools. Revisions never change once
 * saved, so what the person reads is what the run sends.
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
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import type { DirectoryTestCase, DirectoryTestPlan } from "@mcpjam/sdk/browser";
import { useTaskOwnerId } from "@/hooks/use-task-owner-id";
import type { TestPlanView } from "@/lib/apis/directory-test-plan-api";

/** "a", "a and b", "a, b and c". */
function listOf(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const REFUSAL = {
  any: "any refusal",
  "invalid-arguments": "an invalid-arguments refusal",
  "tool-error": "an error from the tool",
} as const;
const HINT = "text-xs text-muted-foreground";

/** A value exactly as the run sends it: whole, wrapped, never cut short. */
function Json({ value }: { value: unknown }) {
  return (
    <pre className="whitespace-pre-wrap break-all rounded border border-border/40 bg-muted/30 p-2 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Every call the revision makes in run order, then what it touches. */
function Calls({ plan }: { plan: DirectoryTestPlan }) {
  const entries = new Map(plan.tools.map((entry) => [entry.tool, entry]));
  // As the sweep runs them: a negative-only tool's valid cases never run.
  const runs = ({ tool, kind }: DirectoryTestCase) =>
    entries.get(tool)?.action === "run" ||
    (entries.get(tool)?.action === "negative-only" && kind === "negative");
  const excluded = plan.tools
    .filter((entry) => entry.action === "excluded")
    .map(({ tool }) => tool);
  const creators = (fixture: string) =>
    listOf(
      plan.cases.filter((c) => c.creates?.includes(fixture)).map((c) => c.id),
    );
  const writers = (fixture: string) =>
    listOf(
      plan.tools.filter((e) => e.writes.includes(fixture)).map((e) => e.tool),
    );
  return (
    <div className="space-y-4 pr-3 text-sm">
      <h3 className="font-medium">Calls, in run order</h3>
      <ol className="list-decimal space-y-3 pl-5">
        {plan.cases.filter(runs).map((testCase) => (
          <li key={testCase.id} className="space-y-1">
            <p>
              {`${testCase.tool}, ${testCase.kind === "valid" ? "valid input" : "negative case"}${entries.get(testCase.tool)?.openWorld ? ", reaches outside the server" : ""}`}
            </p>
            {testCase.arguments ? (
              <Json value={testCase.arguments} />
            ) : (
              <p className={HINT}>No arguments</p>
            )}
            <p className={HINT}>
              {testCase.kind === "valid"
                ? "Expects a result."
                : `Expects ${REFUSAL[testCase.expectedError ?? "any"]}.`}
            </p>
          </li>
        ))}
      </ol>
      {plan.fixtures.length > 0 ? (
        <h3 className="font-medium">Fixtures</h3>
      ) : null}
      {plan.fixtures.map(({ id, description, origin, values }) => (
        <div key={id} className="space-y-1">
          <p>{`${id}: ${description}`}</p>
          <p className={HINT}>
            {origin === "existing"
              ? "Already in the reviewer's account."
              : creators(id)
                ? `Created by ${creators(id)}.`
                : "No case creates it."}
          </p>
          {values ? <Json value={values} /> : null}
          <p className={HINT}>
            {writers(id)
              ? `Tools allowed to change it: ${writers(id)}.`
              : "No tool is allowed to change it."}
          </p>
        </div>
      ))}
      {plan.cleanup.length > 0 ? (
        <h3 className="font-medium">Cleanup</h3>
      ) : null}
      {plan.cleanup.map(({ fixture, tool, arguments: args }) => (
        <div key={fixture} className="space-y-1">
          <p>{`${tool} removes ${fixture}`}</p>
          <Json value={args} />
        </div>
      ))}
      {excluded.length > 0 ? (
        <p>
          {`${listOf(excluded)} ${excluded.length === 1 ? "is" : "are"} excluded and not called.`}
        </p>
      ) : null}
    </div>
  );
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
      <AlertDialogContent
        onEscapeKeyDown={onCancel}
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
      >
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
        <ScrollArea className="min-h-0 flex-1">
          <Calls plan={saved.plan} />
        </ScrollArea>
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
