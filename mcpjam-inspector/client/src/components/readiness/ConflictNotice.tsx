/**
 * A save the backend refused because fields it touched changed after this
 * tab read them. The form shows the saved values; this tab's are held here,
 * beside who changed each field and when, until the person applies theirs
 * again or keeps the saved ones. The hook saves edits to other fields again
 * by itself, so only a real clash asks anything.
 */
import { Fragment } from "react";
import { directoryFlowField, type DirectoryFlow } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import { stampOf, type People } from "./AnswerOrigin";
import { McpjamMark } from "./McpjamChecks";
import { answerText } from "./PortalReview";

export function ConflictNotice({
  flow,
  session,
  people,
}: {
  flow: DirectoryFlow;
  session: Pick<
    DirectorySubmissionSession,
    "conflict" | "view" | "reapply" | "keepSaved"
  >;
  people: People;
}) {
  const held = session.conflict ?? {};
  const keys = Object.keys(held);
  if (keys.length === 0) return null;
  const saved = new Map(
    session.view?.answers.map((answer) => [answer.key, answer]),
  );
  const one = keys.length === 1;
  const changed = one
    ? `${directoryFlowField(flow, keys[0])?.label ?? keys[0]} changed while you were editing, so your change was not saved.`
    : `${keys.length} fields changed while you were editing, so your changes were not saved.`;
  return (
    <div
      role="alert"
      className="mx-10 mb-3 space-y-3 rounded-lg border border-dashed border-warning px-4 py-3 text-sm"
    >
      <p className="flex flex-wrap items-center gap-2">
        <McpjamMark />
        {`${changed} Apply yours again, or keep the saved ${one ? "value" : "values"}.`}
      </p>
      <dl className="grid grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {keys.map((key) => {
          const field = directoryFlowField(flow, key);
          const now = saved.get(key);
          return (
            <Fragment key={key}>
              <dt className="font-medium">{field?.label ?? key}</dt>
              <dd className="min-w-0 space-y-0.5">
                <span className="block truncate">
                  {`Saved: ${answerText(field, now?.value)}`}
                </span>
                {now?.setAt ? (
                  <span className="block truncate text-muted-foreground">
                    {`Changed by ${stampOf(now, people)}`}
                  </span>
                ) : null}
                <span className="block truncate">
                  {`Yours: ${answerText(field, held[key])}`}
                </span>
              </dd>
            </Fragment>
          );
        })}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={session.reapply}>
          Apply my changes again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={session.keepSaved}
        >
          Keep the saved values
        </Button>
      </div>
    </div>
  );
}
