import { FALLBACK_HINT } from "./dynamic-client-registration.js";
import { responseFailureFindingKey } from "./response-error.js";

/**
 * A key that is the same for every occurrence of one debugger step failure,
 * and different between different failures — for grouping them in error
 * reporting.
 *
 * Neither the whole message nor a cut of it will do, in opposite directions:
 *
 * - Cutting at the first sentence MERGES different failures. Every era's
 *   machine reports `Could not discover authorization server metadata. Last
 *   error: …`, and the actual cause — every discovery URL 4xx'd, an HTTP 500,
 *   a network or TLS error — comes after the period.
 * - The whole message SPLITS one failure. The server under test chooses part
 *   of the text: `describeResponseFailure` appends its status text and free-
 *   form `error_description`, and passed-through errors can carry URLs and
 *   ids. That opens a new issue per server wording, client and request, with
 *   no upper bound.
 *
 * So each part is handled by what it is, in the module that writes it:
 *
 * 1. The registration advisory ({@link FALLBACK_HINT}) is removed exactly —
 *    it is appended only when a fallback client exists, to what is otherwise
 *    the same finding. With it, a single trailing period, since the two
 *    registration forms place it differently.
 * 2. A response failure reduces to label, status and OAuth `error` code
 *    ({@link responseFailureFindingKey}).
 * 3. Anything else keeps its full text, cause included, with URLs and long
 *    ids replaced and the length capped — a backstop, so no message can yield
 *    an unbounded number of keys.
 */
export function stepFailureFindingKey(message: string): string {
  const withoutHint = stripTrailingPeriod(
    message.endsWith(` ${FALLBACK_HINT}`)
      ? message.slice(0, -(FALLBACK_HINT.length + 1))
      : message,
  );

  return (
    responseFailureFindingKey(withoutHint) ?? normalizeVariableText(withoutHint)
  );
}

const MAX_KEY_CHARS = 160;

function stripTrailingPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

function normalizeVariableText(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s"'<>)]+/g, "<url>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<id>",
    )
    // A long token with a digit in it: a client id, trace id or hash. Words
    // like `authorization_servers` have no digit and are left alone.
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_KEY_CHARS);
}
