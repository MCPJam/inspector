/**
 * What the model reads when a tool fails with `-32042` (URL elicitation
 * required), and whether that may say a person saw the link.
 *
 * The link reaches a person only where a chat turn has a stream to show it on
 * (the hosted elicitation bridge). Evals, goal runs, event turns and API agent
 * turns have nobody to show it to, and telling the model otherwise makes it
 * wait for, or report, a user action that never happened, which an eval then
 * grades as the server's behavior.
 *
 * The surfacing wrapper and the executor that writes the tool result are
 * different layers that share only the thrown error, so the fact travels on
 * the error itself.
 */

const shownToPerson = new WeakSet<object>();

/** Record that this `-32042` error's link was put in front of a person. */
export function markUrlElicitationShown(error: unknown): void {
  if (error && typeof error === "object") shownToPerson.add(error);
}

export function wasUrlElicitationShown(error: unknown): boolean {
  return !!error && typeof error === "object" && shownToPerson.has(error);
}

export const URL_ELICITATION_SHOWN_MESSAGE =
  "This tool needs the user to complete an interaction at a URL first. The user has been shown the link and may complete it out of band. Retry this tool once they confirm they're done.";

export const URL_ELICITATION_NOT_SHOWN_MESSAGE =
  "This tool needs the user to complete an interaction at a URL first, but no one could be shown the link in this run, so it can't be completed here. Don't wait for the user or say they completed it.";

export function urlElicitationModelMessage(error: unknown): string {
  return wasUrlElicitationShown(error)
    ? URL_ELICITATION_SHOWN_MESSAGE
    : URL_ELICITATION_NOT_SHOWN_MESSAGE;
}
