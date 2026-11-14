/**
 * Arguments a run drafted for the plan's cases that had none. A run never
 * sends a draft: accepting one changes this tab's plan, and saving the plan
 * makes the revision a later run sends it from.
 */
import type {
  PlatformDirectoryTestArgumentDraft as Draft,
  PlatformDirectoryTestArgumentUndecided,
} from "@mcpjam/sdk/platform";
import { Button } from "@mcpjam/design-system/button";
import type { DirectoryTestPlanSession } from "@/hooks/use-directory-test-plan";
import { acceptDraft } from "./test-plan-edits";
import { EXPECTED } from "./TestPlanTools";

const UNDECIDED: Record<
  PlatformDirectoryTestArgumentUndecided["reason"],
  string
> = {
  needs_secret:
    "It needs a secret, which MCPJam never sends to a model. Enter its arguments in the plan below, or exclude the tool as needing a person.",
  needs_fixture:
    "It needs a fixture the plan does not name. Enter its arguments in the plan below.",
  unclear:
    "The tool's schema does not say enough to draft its arguments. Enter them in the plan below.",
  schema_mismatch:
    "Its draft did not match the tool's schema, so MCPJam dropped it. Enter its arguments in the plan below.",
  credential:
    "Its draft matched a credential pattern, so MCPJam dropped it. Enter its arguments in the plan below.",
  schema_invalid:
    "The model's answer could not be read. Enter its arguments in the plan below.",
  provider_error:
    "The model did not answer. Enter its arguments in the plan below.",
  provider_timeout:
    "The model took too long to answer. Enter its arguments in the plan below.",
  ai_unavailable:
    "MCPJam's model was not available. Enter its arguments in the plan below.",
};
const HINT = "text-xs text-muted-foreground";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const many = (count: number, one: string, more: string) =>
  `${count} ${count === 1 ? one : more}`;

function DraftRow({
  draft,
  session,
}: {
  draft: Draft;
  session: DirectoryTestPlanSession;
}) {
  const current = session.plan?.cases.find(({ id }) => id === draft.caseId);
  const saved = session.saved?.plan.cases.find(({ id }) => id === draft.caseId);
  const note = !current
    ? "This case is not in the plan anymore."
    : same(saved?.arguments, draft.arguments)
      ? "The saved plan has these arguments."
      : same(current.arguments, draft.arguments)
        ? "Accepted. Save the plan to keep it."
        : null;
  return (
    <li className="space-y-1.5 rounded-md bg-muted/40 p-3 text-sm">
      <p className="font-mono">{draft.caseId}</p>
      <pre className="overflow-x-auto font-mono text-xs">
        {JSON.stringify(draft.arguments, null, 2)}
      </pre>
      {draft.expectedError ? (
        <p
          className={HINT}
        >{`Expected refusal: ${EXPECTED[draft.expectedError]}`}</p>
      ) : null}
      <p className={HINT}>{draft.rationale}</p>
      {note ? (
        <p className={HINT}>{note}</p>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => session.edit((plan) => acceptDraft(plan, draft))}
        >
          {`Accept for ${draft.caseId}`}
        </Button>
      )}
    </li>
  );
}

export function ArgumentDrafts({
  session,
}: {
  session: DirectoryTestPlanSession;
}) {
  const drafting = session.results?.drafting;
  if (!drafting) return null;
  const { drafts, undecided, unsent } = drafting;
  const { schema, credential } = drafting.dropped;
  const dropped = [
    schema > 0 &&
      `${many(schema, "draft", "drafts")} that did not match the tool's schema`,
    credential > 0 &&
      `${many(credential, "draft", "drafts")} that matched a credential pattern`,
  ].filter(Boolean);
  const revision = session.results?.testPlanRevision;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Drafted arguments</h3>
      <p className="text-sm">
        {`MCPJam drafted these in the run with revision ${revision}. A run never sends a draft. Accept one into the plan, then save the plan to run it.`}
      </p>
      {drafting.status !== "completed" ? (
        <p className="text-sm">
          {drafting.detail ??
            "MCPJam drafted no arguments in this run. Enter the arguments in the plan below."}
        </p>
      ) : null}
      <ul className="space-y-2">
        {drafts.map((draft) => (
          <DraftRow key={draft.caseId} draft={draft} session={session} />
        ))}
      </ul>
      {undecided.length > 0 ? (
        <div className="space-y-1 text-sm">
          <p>
            {`MCPJam did not draft ${many(undecided.length, "case", "cases")}. Enter their arguments in the plan below.`}
          </p>
          <ul className={HINT}>
            {undecided.map(({ caseId, reason, detail }) => (
              <li key={caseId}>
                {`${caseId}: ${UNDECIDED[reason] ?? reason}`}
                {detail ? <span className="block">{detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {dropped.length > 0 ? (
        <p className={HINT}>
          {`MCPJam dropped ${dropped.join(" and ")}. Their cases are listed above as not drafted.`}
        </p>
      ) : null}
      {unsent > 0 ? (
        <p className="text-sm">
          {`${many(unsent, "case without arguments was", "cases without arguments were")} not sent for drafting in this run. Enter their arguments in the plan below.`}
        </p>
      ) : null}
    </div>
  );
}
