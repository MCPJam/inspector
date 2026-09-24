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
 * 3. Anything else keeps its full text, cause included, with every part a
 *    user or server chooses replaced: URLs, bare hostnames and IP addresses
 *    (the debug proxy names the host it refused, not a URL), and long ids.
 *    Those replacements are what bound the number of keys; the length cap
 *    only bounds how long one key can be.
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

// IPv6 before hostnames, so its hex groups are never read as DNS labels. Two
// colons at least, with no whitespace between, so `Bad Request: …` is left alone.
const IPV6_ADDRESS = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;
const IPV4_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Dotted labels ending in an alphabetic TLD, so a version like `3.9.2` is not one.
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

function normalizeVariableText(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s"'<>)]+/g, "<url>")
    .replace(IPV6_ADDRESS, "<ip>")
    .replace(IPV4_ADDRESS, "<ip>")
    .replace(HOSTNAME, "<host>")
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
