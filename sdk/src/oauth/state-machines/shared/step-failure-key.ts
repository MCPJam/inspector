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
 *    the same finding. With it, every trailing period: the two registration
 *    forms place one differently, and a cause that already ends in a period
 *    (Firefox's `NetworkError when attempting to fetch resource.`) gains a
 *    second one before the hint.
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
 *    `evaluating 'e.body.issuer'`), so a global rule merged different MCPJam
 *    bugs into one issue.
 */
export function stepFailureFindingKey(message: string): string {
  const withoutHint = stripTrailingPeriod(
    message.endsWith(` ${FALLBACK_HINT}`)
      ? message.slice(0, -(FALLBACK_HINT.length + 1))
      : message
  );

  return (
    responseFailureFindingKey(withoutHint) ?? normalizeVariableText(withoutHint)
  );
}

const MAX_KEY_CHARS = 160;

function stripTrailingPeriod(text: string): string {
  return text.replace(/\.+$/, "");
}

// Where the debug proxy puts a host (`oauth-proxy.ts`, `pinned-dns.ts`):
//   Could not resolve <host>
//   Could not resolve <lowercased target label> <host>
//   <host> resolves to a private or reserved address (<ip>)
//   … is a private/reserved host (<host>)
//   Refusing a plaintext connection to "<host>": …
// The resolve form's host is the message's last word, after the label's plain
// words, so the lazy words give way until the token reaches the end.
const PROXY_HOSTS: ReadonlyArray<[RegExp, string]> = [
  [/(\bCould not resolve (?:[a-z-]+ )*?)[^\s"'()]+(?=[)"',;]*$)/g, "$1<host>"],
  [/[^\s"'()]+(?= resolves to a private or reserved address\b)/g, "<host>"],
  [/(\bhost \()[^\s)]+(\))/g, "$1<host>$2"],
  [/(\bconnection to ")[^\s"]+(")/g, "$1<host>$2"],
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
      .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "<id>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_KEY_CHARS)
  );
}
