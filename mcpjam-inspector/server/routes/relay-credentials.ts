import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  containsCredential,
  scrubCredentialUrl,
  scrubTelemetryValue,
} from "../../shared/credential-urls.js";

/**
 * The relay's credential pass: no credential URL reaches PostHog through the
 * relay, and a payload the relay cannot show to be clean is not forwarded.
 * posthog-js puts the page URL everywhere (`$current_url`, `$referrer`,
 * autocapture's element chain, a replay's meta event), and on a share link
 * or an OAuth callback that URL is the credential (`shared/credential-urls.ts`
 * has the list). The client scrubs before it sends; this is the backstop for
 * whatever it missed, run inside the privacy gate's rewrite (relay.ts), at
 * every policy, `full` included:
 *
 *   - every event, and a batch's envelope, goes through the registry's
 *     walker (`scrubEventCredentials`); one it cannot finish fails the
 *     request;
 *   - a replay event is never rewritten. It is read for a credential,
 *     strings nested in posthog-js's gzip packing included
 *     (`inspectReplayEvent`), and dropped when it holds one or cannot be read;
 *   - every query parameter but the payload and the project key goes
 *     through the URL scrubber (`scrubForwardedSearch`).
 */

const gunzipAsync = promisify(gunzip);

const TOKEN_FIELDS = ["api_key", "token", "$token"];
const TOKEN_QUERY_PARAMS = ["token", "api_key"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One event, or a batch's envelope, with every credential out of it. Its
 * project key goes to PostHog as it came: every key in the payload has been
 * pinned to our project by now, and a project key is not a credential URL.
 * The walker leaves the event's own api_key / token / $token alone
 * (top-level keys); properties.token is a level down, out of its reach, so
 * it is put back. THROWS when the walker cannot finish (TelemetryScrubError).
 */
export function scrubEventCredentials<T>(event: T): T {
  const clean = scrubTelemetryValue(event, {
    preserveTopLevelKeys: TOKEN_FIELDS,
  });
  if (
    isRecord(event) &&
    isRecord(event.properties) &&
    Object.hasOwn(event.properties, "token") &&
    isRecord(clean) &&
    isRecord(clean.properties)
  ) {
    clean.properties.token = event.properties.token;
  }
  return clean;
}

const PROJECT_KEY_SHAPE = /^phc_[A-Za-z0-9]+$/;

/**
 * The query string as forwarded: every parameter but `data` through the
 * credential scrub. `data` is the payload, already checked and rewritten by
 * the gate, and must reach PostHog as it is. So must the project key
 * parameters (`token`, `api_key`) when they hold a project key (`phc_…`):
 * public by design, and pinned to the relay's own project. PostHog's flags
 * (`compression`, `ver`, `ip`, `_`) carry nothing to scrub and pass as they
 * are. Anything else a client added (`redirect_uri=…`, `code=…`) does not
 * reach PostHog in the clear.
 */
export function scrubForwardedSearch(search: string): string {
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (body === "") return search;
  const out = body.split("&").map((pair) => {
    const [[key, value] = ["", ""]] = new URLSearchParams(pair);
    if (key === "data") return pair;
    if (TOKEN_QUERY_PARAMS.includes(key) && PROJECT_KEY_SHAPE.test(value)) {
      return pair;
    }
    return scrubCredentialUrl(`?${pair}`).slice(1);
  });
  return `?${out.join("&")}`;
}

// ── Replay ─────────────────────────────────────────────────────────────

export type ReplayVerdict = "clean" | "credential" | "undecodable";

/**
 * Reads JSON text without building it, handing every string in it (keys
 * included) to `visit`; the relay's byte scanner (`scanPayloadTokens`).
 * Throws on JSON it cannot read.
 */
export type JsonStringScan = (
  json: Buffer,
  visit: (value: string) => void | Promise<void>,
) => Promise<void>;

/**
 * Nested gzip one request's replay events may inflate to, together. A real
 * batch is about 0.9 MiB as sent, and DOM text compresses around tenfold;
 * a batch past this is undecodable rather than inflated further.
 */
export const RELAY_REPLAY_NESTED_MAX_BYTES = 32 * 1024 * 1024;
// posthog-js nests one level. Gzip found inside nested data is not something
// it produces, and is refused rather than inflated again.
const REPLAY_MAX_NESTING = 1;

// fflate's `strFromU8(bytes, true)` writes one character per byte, so a
// nested gzip string starts with the gzip magic as two characters.
function isNestedGzip(value: string): boolean {
  return (
    value.length >= 2 &&
    value.charCodeAt(0) === 0x1f &&
    value.charCodeAt(1) === 0x8b
  );
}

// A character a latin1 byte string cannot hold.
const BEYOND_LATIN1 = /[^\u0000-ÿ]/;

// A recording repeats itself: every node has the same keys, and tag names,
// class lists and attribute values recur across thousands of nodes. Short
// strings already checked clean are remembered per request, up to a total
// size, so each distinct one costs one credential check.
const CLEAN_MEMO_MAX_STRING_CHARS = 256;
const CLEAN_MEMO_MAX_TOTAL_CHARS = 4 * 1024 * 1024;
// The event loop gets a turn every this many strings of a parsed event.
const YIELD_EVERY_STRINGS = 4096;

/**
 * Reads replay events for a credential: every string in them, and the JSON
 * inside posthog-js's nested gzip strings (full snapshots and mutations
 * packed as `cv` data), so DOM attributes and text are covered as well as
 * the meta event's href, network requests and console lines. One per
 * request: the nested-gzip budget and the clean-string memo are shared by
 * its events.
 */
export class ReplayCredentialInspector {
  private inflatedBytes = 0;
  private readonly knownClean = new Set<string>();
  private knownCleanChars = 0;

  constructor(private readonly scan: JsonStringScan) {}

  /** The verdict on one parsed `$snapshot` event. */
  async inspect(event: unknown): Promise<ReplayVerdict> {
    const pending: unknown[] = [event];
    let strings = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (typeof node === "string") {
        const verdict = await this.inspectString(node, 0);
        if (verdict !== "clean") return verdict;
        if (++strings % YIELD_EVERY_STRINGS === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      } else if (Array.isArray(node)) {
        for (const item of node) pending.push(item);
      } else if (isRecord(node)) {
        for (const [key, value] of Object.entries(node)) {
          pending.push(key, value);
        }
      }
    }
    return "clean";
  }

  private async inspectString(
    value: string,
    nesting: number,
  ): Promise<ReplayVerdict> {
    if (isNestedGzip(value)) return this.inspectNested(value, nesting);
    return this.isClean(value) ? "clean" : "credential";
  }

  private isClean(value: string): boolean {
    const memo = value.length <= CLEAN_MEMO_MAX_STRING_CHARS;
    if (memo && this.knownClean.has(value)) return true;
    if (containsCredential(value)) return false;
    if (
      memo &&
      this.knownCleanChars + value.length <= CLEAN_MEMO_MAX_TOTAL_CHARS
    ) {
      this.knownClean.add(value);
      this.knownCleanChars += value.length;
    }
    return true;
  }

  private async inspectNested(
    value: string,
    nesting: number,
  ): Promise<ReplayVerdict> {
    if (nesting >= REPLAY_MAX_NESTING || BEYOND_LATIN1.test(value)) {
      return "undecodable";
    }
    let text: Buffer;
    try {
      text = await gunzipAsync(Buffer.from(value, "latin1"), {
        maxOutputLength: Math.max(
          1,
          RELAY_REPLAY_NESTED_MAX_BYTES - this.inflatedBytes,
        ),
      });
    } catch {
      // Not gzip after all, truncated, or past the request's budget.
      return "undecodable";
    }
    this.inflatedBytes += text.length;
    let verdict: ReplayVerdict = "clean";
    try {
      await this.scan(text, async (nested) => {
        if (verdict !== "clean") return;
        verdict = await this.inspectString(nested, nesting + 1);
      });
    } catch {
      // Nested data that is not JSON cannot be read for credentials.
      return verdict === "clean" ? "undecodable" : verdict;
    }
    return verdict;
  }
}
