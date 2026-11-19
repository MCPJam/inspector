import type { ToolSet } from "ai";

/**
 * Why the registry left the browser out of a turn, as a code a caller can
 * branch on. The free-text `reason` beside it is for logs and run evidence;
 * deciding what to tell the model from that text would make every copy edit a
 * behavior change.
 */
export type BrowserSuppressionCode =
  /** No current exposure verdict from the backend: stale or never received. */
  | "hosted_transient"
  /** The backend answered: template, rate, panel keypair or catalog unset. */
  | "hosted_not_configured"
  /** The turn's computer is a terminal box, which has no display. */
  | "terminal_only";

/**
 * What the model is told when Browser is on for the client and missing from
 * the turn. Also the `refusal` code the public API returns for an explicit
 * browser request that did not attach.
 */
export type BrowserRefusalReason =
  | "cloud_browser_unavailable"
  | "cloud_browser_not_configured"
  | "cloud_browser_unavailable_installation"
  | "browser_terminal_only";

/**
 * Model-facing copy. Separate from any toast: the model needs to know what to
 * do about the missing browser, and without this it improvises with the shell
 * and hands the person a localhost URL only the workspace can open.
 */
export const BROWSER_REFUSAL_MODEL_CONTEXT: Record<
  BrowserRefusalReason,
  string
> = {
  cloud_browser_unavailable:
    "Cloud Browser is unavailable for this turn. If the user asks to open an " +
    "app, explain that the browser could not start and that they can try " +
    "again in a few minutes.",
  cloud_browser_not_configured:
    "Cloud Browser is not available yet. If the user asks to open an app, " +
    "explain that Browser is not available yet.",
  cloud_browser_unavailable_installation:
    "Cloud Browser is unavailable on this installation. If the user asks to " +
    "open an app, explain that the administrator needs to check the Cloud " +
    "Browser setup.",
  browser_terminal_only:
    "Browser is unavailable on this conversation's computer for this turn. " +
    "If asked to open an app, explain that. Don't run xdg-open or launch a " +
    "desktop browser; headless checks in the terminal are fine. Don't present " +
    "the computer's localhost URL as a link the user can open.",
};

/** Does this turn's built-in toolset let the model drive a browser? */
export function advertisesBrowser(tools: ToolSet | undefined): boolean {
  return Object.keys(tools ?? {}).some((name) => name.startsWith("browser_"));
}

/**
 * The reason Browser is missing from a turn, or nothing to say.
 *
 * Only the refusals the registry tags with a code are explained. The rest stay
 * silent on purpose:
 *  - Browser off for the client: the person turned it off. An ordinary turn
 *    says nothing, and an explicit API request for it is refused before any
 *    model turn starts (`BROWSER_NOT_AVAILABLE`).
 *  - Guests and turns with no computer or conversation scope: the client never
 *    offers them a browser, so there is nothing for the model to explain.
 *  - The browser on this machine: it reports through its own readiness part
 *    and consent gate.
 *  - A harness that cannot pause for tool approval withholds the browser
 *    inside the harness turn, after the model's instructions are built.
 */
export function classifyBrowserRefusal(input: {
  configured: boolean;
  advertised: boolean;
  suppression: BrowserSuppressionCode | undefined;
  hostedMode: boolean;
}): BrowserRefusalReason | undefined {
  if (!input.configured || input.advertised) return undefined;
  switch (input.suppression) {
    case "terminal_only":
      return "browser_terminal_only";
    case "hosted_transient":
      return "cloud_browser_unavailable";
    case "hosted_not_configured":
      return input.hostedMode
        ? "cloud_browser_not_configured"
        : "cloud_browser_unavailable_installation";
    default:
      return undefined;
  }
}

/** The system prompt with the turn's Browser refusal appended, if any. */
export function appendBrowserRefusalContext(
  systemPrompt: string | undefined,
  reason: BrowserRefusalReason | undefined,
): string | undefined {
  if (!reason) return systemPrompt;
  const block = `## Browser\n\n${BROWSER_REFUSAL_MODEL_CONTEXT[reason]}`;
  return systemPrompt ? `${systemPrompt}\n\n${block}` : block;
}

/**
 * Keeps the first browser suppression code the registry reports for a turn.
 * Wire `onToolSuppressed` into the registry context, then read `code`.
 */
export function recordBrowserSuppression() {
  let code: BrowserSuppressionCode | undefined;
  return {
    onToolSuppressed(info: { code?: BrowserSuppressionCode }) {
      if (info.code && code === undefined) code = info.code;
    },
    get code() {
      return code;
    },
  };
}
