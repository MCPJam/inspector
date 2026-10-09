/**
 * One shaping path for every Convex function rejection the UI shows.
 *
 * Convex stamps `[Request ID: <16 hex>]` on EVERY function exception, in dev
 * and in production. Production redacts everything after it to `Server Error`;
 * a dev deployment appends `Uncaught <Name>: <message>` plus the server stack.
 * That request id is searchable in the Convex dashboard's logs page and rides
 * into Sentry as `request_id` on the Convex integration's events, so it is
 * already a join key that reaches the real stack from a screenshot. We keep it
 * and drop everything around it, rather than minting a second id of our own.
 *
 * So a failure toast reads as a sentence plus a reference line, never as a
 * stack trace, and support can go screenshot -> Sentry -> Convex logs.
 */

/**
 * A support reference as it is spliced into a message: `(ref <id>)`.
 *
 * Bounded to the 16 hex digits Convex actually stamps, unlike the patterns
 * that READ a Convex message below. The asymmetry is deliberate: those parse
 * a third party's output, where being liberal costs nothing and being strict
 * would silently drop every reference if Convex ever changed the shape. This
 * one re-parses OUR own output, and it runs against every error toast string
 * in the app, so a sentence that merely happens to end in something like
 * `(ref deadbeef)` must not be restructured into a Reference line.
 *
 * If the two ever disagree, the reference stays inline in the sentence rather
 * than moving to its own line. Still readable, still copied, nothing lost.
 */
const SUPPORT_REFERENCE = /\(ref ([0-9a-f]{16})\)\s*$/;

/**
 * `[Request ID: …]`, optionally behind the browser client's own
 * `[CONVEX M(<fn>)]` prefix. The remainder is whatever the deployment chose to
 * disclose, which may be several lines of server stack.
 */
const CONVEX_REJECTION =
  /^(?:\[CONVEX [A-Z]+\([^)]*\)\]\s*)?\[Request ID: ([0-9a-f]+)\]\s*([\s\S]*)$/;

/** The request id alone, wherever it sits in a message. */
const REQUEST_ID = /\[Request ID: ([0-9a-f]+)\]/;

/** Any remaining `[CONVEX …]`-style prefix on a message that carries no id. */
const LEADING_BRACKET_PREFIX = /^\[[^\]]*\]\s*/;

/** What production substitutes for every plain throw. */
const REDACTED_BODY = "Server Error";

/** What the user reads when the deployment disclosed nothing at all. */
const REDACTED_MESSAGE = "Something went wrong";

/** Toasts are one or two lines; a message longer than this is a stack in disguise. */
const MAX_MESSAGE_LENGTH = 400;

export type ConvexFailure = {
  /** A human sentence. Never a stack, never longer than 400 characters. */
  message: string;
  /** The Convex request id, when the rejection carried one. */
  requestId: string | null;
  /** True when production masked the real failure as `Server Error`. */
  redacted: boolean;
  /**
   * True when the backend worded this for the user — a `ConvexError` payload.
   * An expected outcome rather than an incident, so it gets no reference.
   *
   * Carried on the result rather than re-derived by callers: answering it a
   * second time means running a foreign object's getters twice on the path
   * that is already handling a failure.
   */
  refusal: boolean;
};

/** The text a thrown value carries, if it carries any. */
function messageOf(error: unknown): string | null {
  if (typeof error === "string") return error;
  // Every read below can run a getter on an object we did not construct, and
  // this whole path exists to explain a failure that already happened.
  try {
    if (error instanceof Error) {
      return typeof error.message === "string" ? error.message : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The first line of `text`, with the server stack removed.
 *
 * Convex's dev disclosure is `<message>\n    at <frame>\n    at <frame>…`, and
 * the browser client appends its own `Called by client` line. Neither is
 * something a user can act on, and a toast that shows them reads as a crash.
 */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^at\s/.test(trimmed)) break;
    if (trimmed === "Called by client") break;
    return trimmed;
  }
  return "";
}

/**
 * The application payload a `ConvexError` carries, if there is one.
 *
 * Convex only delivers a message intact to a production browser when the
 * backend threw a `ConvexError`; its payload lands on `data` (a string, or a
 * record with `message`). Those are sentences a human wrote for this user, so
 * they are shown unchanged.
 */
function applicationPayload(error: unknown): string | null {
  // Guarded, not trusted, like `attachedNormalized` in `error-reporting`: the
  // thrown value is whatever a rejected promise carried, so `data` (or the
  // `in` check, on a Proxy) can run code that throws. This function is on the
  // path that EXPLAINS a failure, and every caller passes its result straight
  // to a toast or into error state, so a throw here would swallow the message
  // the user was owed and re-throw inside a `catch` that was already handling
  // something.
  try {
    if (!error || typeof error !== "object" || !("data" in error)) return null;
    const data = (error as { data: unknown }).data;
    if (typeof data === "string" && data.trim())
      return data.slice(0, MAX_MESSAGE_LENGTH);
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.slice(0, MAX_MESSAGE_LENGTH);
      }
    }
  } catch {
    // Unreadable payload: fall through to the message, then the fallback.
    return null;
  }
  return null;
}

/**
 * The Convex request id on a rejection, for reporting.
 *
 * Present on a `ConvexError` too: the payload is what the user reads, but the
 * id still identifies the invocation in the dashboard's logs.
 */
export function getConvexRequestId(error: unknown): string | null {
  const message = messageOf(error);
  if (!message) return null;
  return REQUEST_ID.exec(message)?.[1] ?? null;
}

/** How a request id is spliced into a sentence the user can screenshot. */
export function formatSupportReference(requestId: string): string {
  return `(ref ${requestId})`;
}

/**
 * Peel a `(ref …)` suffix back off a message.
 *
 * The toast layer renders the reference on its own line rather than trailing
 * the sentence, so it has to undo the splice `convexErrMessage` made. Keeping
 * both halves in one module is what stops the two spellings from drifting.
 */
export function splitSupportReference(text: string): {
  text: string;
  requestId: string | null;
} {
  const match = SUPPORT_REFERENCE.exec(text);
  if (!match) return { text, requestId: null };
  return { text: text.slice(0, match.index).trim(), requestId: match[1] };
}

/**
 * Turn any Convex rejection into something a user can read and quote back.
 *
 * The three shapes that matter:
 * - a `ConvexError` payload, shown unchanged (the backend worded it);
 * - a production plain throw, which discloses nothing beyond the request id;
 * - a dev plain throw, which discloses the real message AND the server stack.
 */
export function describeConvexFailure(
  error: unknown,
  fallback: string,
): ConvexFailure {
  const requestId = getConvexRequestId(error);

  const payload = applicationPayload(error);
  if (payload) {
    return {
      message: payload,
      requestId,
      redacted: false,
      // A `data` payload IS the refusal signal here, deliberately duck-typed
      // rather than gated on `instanceof ConvexError`.
      //
      // Two reasons. `data` is the only field that survives to a production
      // browser, so if `instanceof` ever failed — a second copy of `convex` in
      // the bundle, a realm boundary — the user would stop seeing the
      // backend's own wording and get the generic sentence instead, which is
      // the regression `github-checks-errors` carries a comment about. And the
      // shape is already load-bearing in tests that stand in for a refusal
      // without constructing one (`SwarmsTab.overview`, for instance, throws
      // `Object.assign(new Error(…), { data: { code: "FORBIDDEN", … } })` and
      // asserts the bare sentence reaches the toast).
      refusal: true,
    };
  }

  const raw = messageOf(error);
  if (!raw || !raw.trim()) {
    return { message: fallback, requestId, redacted: false, refusal: false };
  }

  const rejection = CONVEX_REJECTION.exec(raw);
  if (rejection) {
    const body = rejection[2];
    const disclosed = firstMeaningfulLine(
      // Production says only `Server Error`; a dev deployment says it too, on
      // its own line, before the message that actually happened.
      body.startsWith(REDACTED_BODY) ? body.slice(REDACTED_BODY.length) : body,
    );
    if (!disclosed) {
      return {
        message: REDACTED_MESSAGE,
        requestId,
        redacted: true,
        refusal: false,
      };
    }
    return {
      message: disclosed.slice(0, MAX_MESSAGE_LENGTH),
      requestId,
      redacted: false,
      refusal: false,
    };
  }

  // Not a Convex rejection, or one whose prefix we do not recognise: still
  // drop any bracketed prefix and any stack, and show the first line.
  const message = firstMeaningfulLine(
    raw.replace(LEADING_BRACKET_PREFIX, ""),
  ).slice(0, MAX_MESSAGE_LENGTH);
  return {
    message: message || fallback,
    requestId,
    redacted: false,
    refusal: false,
  };
}

/**
 * Extract a user-facing message from a Convex mutation/query rejection.
 *
 * The shaped sentence, with `(ref <id>)` appended when the failure was an
 * incident rather than a refusal. `toast.error` lifts that suffix onto its own
 * `Reference <id>` line; a caller that renders the string inline (an inline
 * form error, say) keeps it where it is. A `ConvexError` payload never gets
 * one: it is an expected outcome the backend worded on purpose, and a
 * reference on it reads as a crash.
 */
export function convexErrMessage(error: unknown, fallback: string): string {
  const { message, requestId, refusal } = describeConvexFailure(
    error,
    fallback,
  );
  if (!requestId || refusal) return message;
  return `${message} ${formatSupportReference(requestId)}`;
}

/**
 * Whether a `useQuery` throw means the deployment does not serve the function
 * at all — a dark ship, or a browser outliving a rollback — rather than the
 * function failing. Only the DEV shapes are nameable: production redacts
 * every non-`ConvexError` message to "Server Error", so a caller that must
 * recognise a dark ship in production has to match on the function name in
 * the `[CONVEX Q(<name>)]` prefix instead (see `ServerUrlChangeHistory`).
 */
export function isConvexQueryUnavailable(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  return (
    // The function is not deployed (dark ship, or a browser outliving a rollback).
    message.includes("Could not find public function") ||
    // No ConvexProvider above this tree.
    message.includes("Could not find Convex client")
  );
}
