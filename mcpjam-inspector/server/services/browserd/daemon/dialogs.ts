/**
 * JavaScript dialogs — `alert`, `confirm`, `prompt`, `beforeunload`.
 *
 * A dialog stops the renderer. Not "slows": stops. `requestAnimationFrame`
 * never fires, so the settle step burns its whole 10s budget and reports an
 * unsettled page; the next screenshot is the frame from before the dialog; and
 * every subsequent command does the same thing again. Until now nothing in the
 * daemon knew what a dialog was, so a page that called `confirm()` on a click
 * left the tab in exactly that state for as long as the browser lived, and the
 * model was told only that its actions were not settling.
 *
 * THE DEFAULTS ARE THE SAFE ANSWER, NOT THE AGREEABLE ONE. A model cannot see
 * a dialog and cannot be asked about one, so an agent-driven dialog is
 * answered the way an absent user's browser should answer it:
 *
 *   - `alert` — dismissed. There is only one button; the page has been read.
 *   - `confirm` — CANCELLED. "Delete this account?" defaults to no, and a
 *     dialog is the one place a page asks a question whose default answer we
 *     are choosing on someone's behalf.
 *   - `prompt` — cancelled, for the same reason plus one: any text we invented
 *     would be a value the page attributes to the user.
 *   - `beforeunload` — accepted, because the agent asked to navigate and this
 *     is the page asking whether it meant it.
 *
 * WHAT WAS DECIDED IS RECORDED, on the result, so the model is never left to
 * infer it. "I clicked Delete and the page did nothing" and "I clicked Delete,
 * a confirmation appeared, and it was cancelled on your behalf" lead to
 * completely different next moves.
 */

/** The four kinds a page can raise. */
export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

/** A dialog the page is currently blocked on. */
export interface PendingDialog {
  kind: DialogKind;
  /** The page's own text. Page-authored, so it is fenced like any page string. */
  message: string;
  /** `prompt` only: the value the page pre-filled. */
  defaultPrompt?: string;
  /** ms since epoch, so a reader can tell "just now" from "before my act". */
  at: number;
}

/** What was done about it, once something has been. */
export interface DialogOutcome {
  kind: DialogKind;
  message: string;
  choice: "accepted" | "dismissed";
  /** Set when the choice was made for the agent rather than by a person. */
  auto?: true;
}

/**
 * The agent-source default for a kind: `true` accepts, `false` dismisses.
 *
 * One function rather than a table at each call site, because both engines
 * answer their own dialogs and a default that differed between them would be a
 * page behaving differently depending on which browser was driving it.
 */
export function agentDefaultAccepts(kind: DialogKind): boolean {
  return kind === "beforeunload";
}

/**
 * Commands that are still safe to run while a dialog is open.
 *
 * The page is blocked, so anything that touches it hangs or lies. What still
 * works is reading state the daemon already holds, and looking at the frame —
 * which is precisely what a caller needs in order to understand the refusal it
 * just got. Tab lifecycle stays available so a wedged tab can always be
 * closed.
 */
export function safeUnderDialog(action: {
  kind: string;
  mode?: string;
  verb?: string;
}): boolean {
  if (action.kind === "observe") {
    return (
      action.mode === "screenshot" ||
      action.mode === "url" ||
      action.mode === "console" ||
      action.mode === "webmcp_revision"
    );
  }
  if (action.kind === "act") {
    return action.verb === "close_tab" || action.verb === "activate_tab";
  }
  return false;
}

/** The refusal a blocked command gets, in the model's own terms. */
export function dialogRefusal(dialog: PendingDialog): string {
  const quoted = dialog.message ? `: "${dialog.message}"` : "";
  return (
    `dialog_pending: a JavaScript ${dialog.kind} dialog is blocking this page` +
    `${quoted}. The page cannot be read or acted on until it is answered — ` +
    "hand the browser back so a person can answer it, or close the tab."
  );
}
