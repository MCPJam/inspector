/**
 * Where an answer came from, under the copied field: the portal's default,
 * the account, or who set or confirmed it, how and when. The portal shows
 * none of this, so it is marked "MCPJam".
 *
 * A declaration nobody has stood behind is called out, with a way to
 * confirm it: the portal submits its default as if somebody had said it.
 * What the person typed here themselves carries no mark, so the copy stays
 * the portal's and the marks point at what someone else, or the portal, put
 * there.
 */
import type {
  DirectoryAnswer,
  DirectoryFieldIssue,
  DirectoryFlowField,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { McpjamMark } from "./McpjamChecks";

/** The signed-in principals behind answers and events, by name. */
export interface People {
  /** The signed-in person's user id: what they wrote reads as "you". */
  you?: string;
  nameOf: (userId: string) => string | undefined;
}

export const NO_PEOPLE: People = { nameOf: () => undefined };

const CHANNELS: Record<NonNullable<DirectoryAnswer["setVia"]>, string> = {
  web: "in MCPJam",
  api: "via the API",
  cli: "via the CLI",
  mcp: "via MCP",
  agent: "via an agent",
};

/** The origins that mean someone stood behind the value (the SDK's rule). */
const STOOD_BEHIND: ReadonlySet<string> = new Set(["set", "confirmed"]);

const DAY = { month: "short", day: "numeric", year: "numeric" } as const;

export const dayOf = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", DAY);

/** A signed-in principal, with what an agent says it is beside it. */
export function writerOf(
  people: People,
  principal: string | undefined,
  label?: string,
): string {
  const person =
    principal && principal === people.you
      ? "you"
      : (principal && people.nameOf(principal)) || "a project member";
  return label ? `${label} (signed in as ${person})` : person;
}

/** Who wrote an answer, how and when: "you in MCPJam on Nov 13, 2026". */
export function stampOf(answer: DirectoryAnswer, people: People): string {
  const how = answer.setVia ? ` ${CHANNELS[answer.setVia]}` : "";
  const when = answer.setAt ? ` on ${dayOf(answer.setAt)}` : "";
  return `${writerOf(people, answer.setBy, answer.setByLabel)}${how}${when}`;
}

const VERB: Record<
  Exclude<DirectoryAnswer["origin"], "default" | "account">,
  string
> = {
  set: "Set",
  confirmed: "Confirmed",
  imported: "Imported",
  reset: "Reset",
};

export function AnswerOrigin({
  field,
  answer,
  issue,
  people,
  onConfirm,
}: {
  field: DirectoryFlowField;
  answer: DirectoryAnswer | undefined;
  /** The field's issue: a confirmation under older wording asks again. */
  issue?: DirectoryFieldIssue;
  people: People;
  onConfirm: () => void;
}) {
  // No answer, or an edit this tab has not saved: nothing to attribute yet.
  if (!answer || (STOOD_BEHIND.has(answer.origin) && !answer.setAt)) {
    return null;
  }
  const mine =
    answer.origin === "set" &&
    answer.setVia === "web" &&
    !answer.setByLabel &&
    answer.setBy !== undefined &&
    answer.setBy === people.you;
  if (mine && !field.declaration) return null;
  const standing = STOOD_BEHIND.has(answer.origin);
  const unconfirmed =
    field.declaration && (!standing || issue?.code === "wordingChanged");
  let text: string;
  if (answer.origin === "default") {
    text = field.declaration
      ? "Nobody has confirmed this answer."
      : "The portal preselects it.";
  } else {
    const source =
      answer.origin === "account"
        ? "From your account"
        : `${VERB[answer.origin]} by ${stampOf(answer, people)}`;
    text =
      unconfirmed && !standing
        ? `${source}. Nobody has confirmed it since.`
        : source;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <McpjamMark />
      {answer.origin === "default" ? (
        <span className="rounded border border-dashed border-warning px-1.5 py-0.5 text-foreground">
          Default
        </span>
      ) : null}
      <span>{text}</span>
      {unconfirmed ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 px-2"
          onClick={onConfirm}
        >
          Confirm
        </Button>
      ) : null}
    </div>
  );
}
