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
 *   machine reports `Could not discover authorization server metadata. …`,
 *   and the actual cause — what each well-known URL returned: a 404, an HTTP
 *   500, a network or TLS error — comes after the period.
 * - The whole message SPLITS one failure. The server under test chooses part
 *   of the text: `describeResponseFailure` appends its status text and free-
 *   form `error_description`, and passed-through errors can carry URLs and
 *   ids. That opens a new issue per server wording, client and request, with
 *   no upper bound.
 *
 * So each part is handled by what it is, in the module that writes it:
 *
 * 1. The registration advisory ({@link FALLBACK_HINT}) is removed exactly —
 *    it is appended only when no pre-registered client is available to fall
 *    back to, to what is otherwise the same finding. With it, every trailing
 *    period: the two registration forms place one differently, and a cause
 *    that already ends in a period (Firefox's `NetworkError when attempting
 *    to fetch resource.`) gains a second one before the hint.
 * 2. A response failure reduces to label, status and OAuth `error` code
 *    ({@link responseFailureFindingKey}).
 * 3. Anything else keeps its full text, cause included, with every part a
 *    user or server chooses replaced: URLs, IP addresses, long ids, and the
 *    host in the debug proxy's own refusals, which name it bare rather than
 *    as a URL. Those replacements are what bound the number of keys; the
 *    length cap only bounds how long one key can be.
 *
 *    Hosts are replaced only where the proxy's wording puts one, never
 *    anywhere a dotted name appears. A dotted name is also a property path,
 *    and our own step crashes quote one (`e.json is not a function`,
 *    `evaluating 'e.body.issuer'`); replacing those would merge different
 *    MCPJam bugs into one issue.
 */
export function stepFailureFindingKey(message: string): string {
  // Cut before any pattern runs, after the hint so removing it still works.
  // This bounds the exported function for any caller, since the server writes
  // this text and no pattern below then sees more than this. (The debugger's
  // reporting path already passes sanitized text capped well under it.) The
  // key is cut to 160 characters, so nothing real is lost.
  const withoutHint = stripTrailingPeriod(
    message.endsWith(` ${FALLBACK_HINT}`)
      ? message.slice(0, -(FALLBACK_HINT.length + 1))
      : message
  ).slice(0, MAX_NORMALIZED_CHARS);

  return (
    responseFailureFindingKey(withoutHint) ?? normalizeVariableText(withoutHint)
  );
}

const MAX_KEY_CHARS = 160;
const MAX_NORMALIZED_CHARS = 4000;

const PERIOD = ".".charCodeAt(0);

/**
 * Not `/\.+$/`: an unanchored-start `+` before `$` retries the run from every
 * index when the match fails, so a message padded with periods costs O(n²),
 * and `error_description` is the server's text. A scan from the end is linear
 * and says the same thing.
 */
function stripTrailingPeriod(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === PERIOD) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

// Where the debug proxy puts a host. This wording is copied by hand from
// `oauth-proxy.ts` and `pinned-dns.ts`, so it CAN drift from them; the tests
// pin each form, and a change to a refusal there needs a change here.
//   Could not resolve <host>
//   Could not resolve <lowercased target label> <host>
//   <host> resolves to a private or reserved address (<ip>)
//   … is a private/reserved host (<host>)
//   Refusing a plaintext connection to "<host>": …
// The resolve form's host is the last word of its attempt: the end of the
// message, or the `; ` before the next attempt when discovery reports several
// (`describeAuthorizationServerDiscoveryFailure`). The lazy label words give
// way until the token reaches one of those.
//
// Every host run is bounded to {1,253}, the maximum length of a DNS name. The
// private-address rule is why: its token comes BEFORE its literal, so an
// unbounded `+` would retry the whole run from each index, O(n²) on a message
// padded with periods. The other three sit behind a literal and fail fast, but
// they are bounded too so the next edit here cannot reintroduce it.
const PROXY_HOSTS: ReadonlyArray<[RegExp, string]> = [
  [
    /(\bCould not resolve (?:[a-z-]{1,63} ){0,8}?)[^\s"'();]{1,253}(?=[)"',]*(?:;|$))/g,
    "$1<host>",
  ],
  [
    /[^\s"'()]{1,253}(?= resolves to a private or reserved address\b)/g,
    "<host>",
  ],
  [/(\bhost \()[^\s)]{1,253}(\))/g, "$1<host>$2"],
  [/(\bconnection to ")[^\s"]{1,253}(")/g, "$1<host>$2"],
];
// Two colons at least, with no whitespace between, so `Bad Request: …` is
// left alone.
const IPV6_ADDRESS =
  /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;
const IPV4_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function normalizeVariableText(text: string): string {
  const withoutHosts = PROXY_HOSTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text.replace(/\bhttps?:\/\/[^\s"'<>)]+/g, "<url>")
  );
  return (
    withoutHosts
      .replace(IPV6_ADDRESS, "<ip>")
      .replace(IPV4_ADDRESS, "<ip>")
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<id>"
      )
      // A long token with a digit in it: a client id, trace id or hash. Words
      // like `authorization_servers` have no digit and are left alone.
      //
      // The digit test is a callback, not a `(?=[A-Za-z0-9_-]*\d)` lookahead.
      // `-` is in the class but is not a `\w`, so in a run like `a-a-a-…`
      // every letter sits at a `\b` and the lookahead would rescan the rest of
      // the run from each one. Matching the token first and testing it once is
      // linear.
      .replace(/\b[A-Za-z0-9_-]{16,}\b/g, (token) =>
        /\d/.test(token) ? "<id>" : token
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_KEY_CHARS)
  );
}
