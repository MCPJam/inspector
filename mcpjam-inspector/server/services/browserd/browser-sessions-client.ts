/**
 * Durable session records for a browserd daemon running inside a desktop
 * computer (`browserSessions`, backend `/browser-runtime/*`).
 *
 * The row is a replica-independent CACHE plus reachability record: it names
 * the daemon's public origin, port, per-boot bearer and bootId — and the noVNC
 * stream URL + password, which are minted at stream start and exist nowhere
 * else, so a fresh inspector replica can only recover them here. Unlike the
 * plugin-session gate, a hit is NOT trusted on its own: the ensure path
 * re-verifies with the daemon's authenticated `/v1/status` (bootId + bearer)
 * before reuse.
 *
 * Server-to-server only. Every route is authenticated with
 * `INSPECTOR_SERVICE_TOKEN` (`x-inspector-service-token`), because the record
 * holds a bearer that grants browser command execution inside a user's VM and
 * a password that unlocks its live desktop view — a browser client must never
 * be able to read or write one.
 */
import { logger } from "../../utils/logger.js";

/** Why the backend refused to hand back an otherwise-existing session. */
export type BrowserSessionStale =
  /** The daemon bundle shipped new bytes: the running daemon is old code. */
  | "bundle_changed"
  /** The live daemon runs the OTHER profile mode (persistent vs ephemeral). */
  | "context_mode_changed"
  /** The box the session named is gone, hibernating, or never live. */
  | "box_unavailable";

export type BrowserContextMode = "persistent" | "ephemeral";

export interface BrowserSessionRecord {
  sessionId: string;
  computerId: string;
  bootId: string;
  browserdToken: string;
  browserdPort: number;
  publicOrigin: string;
  streamUrl: string;
  streamPassword: string;
  bundleHash: string;
  contextMode: BrowserContextMode;
}

export interface BrowserSessionLookup {
  /**
   * Did the control plane actually ANSWER? `false` means the question is
   * unanswered (no config, transport failure, non-2xx, unparseable body),
   * which is different from an answered "there is no session". Both lead to
   * the same relaunch behavior on the ensure path; they differ only for
   * diagnostics.
   */
  reachable: boolean;
  session: BrowserSessionRecord | null;
  stale?: BrowserSessionStale;
  /**
   * The row id the backend saw for this computer, present even when the row
   * is stale or unusable. Passed back as `replacesSessionId` on a relaunch
   * record so that write is a compare-and-swap against THIS observation; its
   * absence means "no row existed", which is equally load-bearing.
   */
  observedSessionId?: string;
  /**
   * Just enough of a STALE row to ask its daemon who is holding it.
   *
   * The caller's next move after a stale answer is to `pkill` that daemon, and
   * the only thing between that and a person mid-login is asking its lease
   * first — which needs an address. `session: null` alone gave none, and
   * because the backend checks the bundle hash before anything else, that is
   * the state EVERY box is in immediately after a deploy.
   *
   * Absent means nobody to ask: either the box is not serving, or the backend
   * predates this field. The caller must treat both the same way it always
   * did, which is the graceful degradation this rollout needs — the inspector
   * ships before the control plane does.
   */
  staleSession?: {
    publicOrigin: string;
    browserdToken: string;
    bootId: string;
    contextMode: BrowserContextMode;
  };
}

const LOOKUP_PATH = "/browser-runtime/session/lookup";
const RECORD_PATH = "/browser-runtime/session/record";
const TOUCH_PATH = "/browser-runtime/session/touch";
const RELAUNCH_CLAIM_PATH = "/browser-runtime/relaunch/claim";
const RELAUNCH_RELEASE_PATH = "/browser-runtime/relaunch/release";

/** Above the backend's own latency and far below any turn deadline. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A lost compare-and-swap on `record` — a normal answer, not a failure. */
const CONFLICT_STATUS = 409;
const CONFLICT = Symbol("browser-session-record-conflict");

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * POST with the service token, or `null` when this deployment cannot make the
 * call at all (no Convex url, no service token, transport failure, non-2xx).
 * Never throws: the ensure path's fail-closed answer to an unreachable
 * control plane is "no reusable session" (a relaunch), and a record that does
 * not land is a refusal — a throw here would add nothing but a 500.
 */
async function postServiceAuthorized(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown | null> {
  const base = process.env.CONVEX_HTTP_URL?.trim();
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN?.trim();
  if (!base || !serviceToken) return null;

  // Every request here carries the service token, and the responses carry a
  // daemon bearer and a stream password. The destination comes from an env
  // var, so refuse to put those on the wire unless it is HTTPS — a
  // misconfigured `http://` deployment would otherwise ship credentials in
  // cleartext, and the failure would look like "sessions don't work" rather
  // than "we leaked". Loopback is exempt: local dev runs the backend on
  // `http://127.0.0.1`, where there is no network to intercept.
  let target: URL;
  try {
    target = new URL(path, base);
  } catch {
    logger.warn("[browser-runtime] CONVEX_HTTP_URL is not a valid URL", {
      path,
    });
    return null;
  }
  const loopback =
    target.hostname === "localhost" ||
    target.hostname === "127.0.0.1" ||
    target.hostname === "[::1]" ||
    target.hostname === "::1";
  if (target.protocol !== "https:" && !loopback) {
    logger.warn(
      "[browser-runtime] refusing to send session credentials over a non-HTTPS control plane",
      { path, protocol: target.protocol },
    );
    return null;
  }

  // `addEventListener("abort")` never fires on a signal that already aborted.
  if (signal?.aborted) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify(body),
      // Never follow a redirect: the header IS the credential, and a redirect
      // hop is a destination nobody reviewed. (Fetch strips `authorization`
      // cross-origin, but this token rides a custom header, which is not
      // covered by that rule.)
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      // 409 on `record` is a lost boot race, not a failure — the caller
      // handles it. Keep it out of the warn stream but let the caller see it.
      if (response.status === CONFLICT_STATUS) return CONFLICT;
      logger.warn("[browser-runtime] session route rejected the request", {
        path,
        status: response.status,
      });
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.warn("[browser-runtime] session route unreachable", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseSession(raw: unknown): BrowserSessionRecord | null {
  if (!isRecord(raw)) return null;
  const {
    sessionId,
    computerId,
    bootId,
    browserdToken,
    browserdPort,
    publicOrigin,
    streamUrl,
    streamPassword,
    bundleHash,
    contextMode,
  } = raw;
  if (
    typeof sessionId !== "string" ||
    typeof computerId !== "string" ||
    computerId.length === 0 ||
    typeof bootId !== "string" ||
    bootId.length === 0 ||
    typeof browserdToken !== "string" ||
    browserdToken.length === 0 ||
    typeof browserdPort !== "number" ||
    !Number.isInteger(browserdPort) ||
    browserdPort < 1 ||
    browserdPort > 65535 ||
    typeof publicOrigin !== "string" ||
    publicOrigin.length === 0 ||
    typeof streamUrl !== "string" ||
    streamUrl.length === 0 ||
    typeof streamPassword !== "string" ||
    streamPassword.length === 0 ||
    typeof bundleHash !== "string" ||
    (contextMode !== "persistent" && contextMode !== "ephemeral")
  ) {
    // A row we cannot fully read is not a row we may reuse: every field above
    // is load-bearing for reaching the right daemon with the right credential
    // — or for the panel reaching the right stream with its password.
    return null;
  }
  return {
    sessionId,
    computerId,
    bootId,
    browserdToken,
    browserdPort,
    publicOrigin,
    streamUrl,
    streamPassword,
    bundleHash,
    contextMode,
  };
}

/**
 * The narrow shape the backend returns for a stale row — every field or none.
 *
 * A partial answer is refused rather than patched up: the point of these three
 * is to reach one specific daemon and ask it a question, and two out of three
 * reaches nothing. Absent is a valid answer (older backend, or a box that is
 * not serving), and the caller already handles it.
 */
function parseStaleSession(
  raw: unknown,
): BrowserSessionLookup["staleSession"] | undefined {
  if (!isRecord(raw)) return undefined;
  const { publicOrigin, browserdToken, bootId, contextMode } = raw;
  if (
    typeof publicOrigin !== "string" ||
    publicOrigin.length === 0 ||
    typeof browserdToken !== "string" ||
    browserdToken.length === 0 ||
    typeof bootId !== "string" ||
    bootId.length === 0 ||
    (contextMode !== "persistent" && contextMode !== "ephemeral")
  ) {
    return undefined;
  }
  return { publicOrigin, browserdToken, bootId, contextMode };
}

/**
 * Is there a plausibly-live daemon for this computer at exactly this bundle?
 * Staleness is the backend's verdict; daemon liveness is then re-verified by
 * the caller against `/v1/status` — the row alone never admits.
 */
export async function lookupBrowserSession(args: {
  computerId: string;
  expectedBundleHash: string;
  /**
   * The profile mode the caller intends to run in; a row in the other mode
   * comes back as `stale: "context_mode_changed"` rather than reusable.
   *
   * REQUIRED, and `"any"` is the explicit opt-out for a diagnostic reader.
   * The backend rejects a lookup that names no mode: when omission meant
   * "skip the check", an eval that forgot to declare itself was handed a
   * persistent daemon carrying someone's live cookies.
   */
  expectedContextMode: BrowserContextMode | "any";
  signal?: AbortSignal;
}): Promise<BrowserSessionLookup> {
  const raw = await postServiceAuthorized(
    LOOKUP_PATH,
    {
      computerId: args.computerId,
      expectedBundleHash: args.expectedBundleHash,
      expectedContextMode: args.expectedContextMode,
    },
    args.signal,
  );
  if (!isRecord(raw)) return { reachable: false, session: null };
  const stale = raw.stale;
  const observedSessionId = raw.observedSessionId;
  const staleSession = parseStaleSession(raw.staleSession);
  return {
    reachable: true,
    session: parseSession(raw.session),
    ...(staleSession ? { staleSession } : {}),
    ...(stale === "bundle_changed" ||
    stale === "context_mode_changed" ||
    stale === "box_unavailable"
      ? { stale }
      : {}),
    ...(typeof observedSessionId === "string" && observedSessionId
      ? { observedSessionId }
      : {}),
  };
}

/**
 * The three ways a record can end. `conflict` is the compare-and-swap loss —
 * another replica booted and recorded first — and is a NORMAL answer: the
 * caller stops its own daemon and adopts the winner's session. `failed` means
 * the write did not land at all, and the caller must refuse, because an
 * unrecorded runtime is one no replica can later find and whose stream
 * password nothing can ever recover.
 */
export type BrowserSessionRecordResult =
  | { status: "recorded"; sessionId: string }
  | { status: "conflict" }
  | { status: "failed" };

/**
 * Publish a freshly booted daemon, replacing exactly the row the caller
 * observed at lookup (`replacesSessionId`; omit when it observed none). The
 * backend refuses the write when the current row disagrees — see
 * `internalRecordSession`'s compare-and-swap.
 */
export async function recordBrowserSession(args: {
  computerId: string;
  bootId: string;
  browserdToken: string;
  browserdPort: number;
  publicOrigin: string;
  streamUrl: string;
  streamPassword: string;
  bundleHash: string;
  contextMode: BrowserContextMode;
  replacesSessionId?: string;
  signal?: AbortSignal;
}): Promise<BrowserSessionRecordResult> {
  const raw = await postServiceAuthorized(
    RECORD_PATH,
    {
      computerId: args.computerId,
      bootId: args.bootId,
      browserdToken: args.browserdToken,
      browserdPort: args.browserdPort,
      publicOrigin: args.publicOrigin,
      streamUrl: args.streamUrl,
      streamPassword: args.streamPassword,
      bundleHash: args.bundleHash,
      contextMode: args.contextMode,
      ...(args.replacesSessionId
        ? { replacesSessionId: args.replacesSessionId }
        : {}),
    },
    args.signal,
  );
  if (raw === CONFLICT) return { status: "conflict" };
  // An EMPTY id is a failure, not a record: it would ride out in the handle and
  // then address every later touch and release at nothing, so the session would
  // look alive to us and idle to the sweeper.
  if (!isRecord(raw) || typeof raw.sessionId !== "string" || !raw.sessionId) {
    return { status: "failed" };
  }
  return { status: "recorded", sessionId: raw.sessionId };
}

/**
 * Refresh a session's activity. `command` marks real use; `panel` is the
 * Browser Panel keepalive and only counts within the server-side ceiling —
 * the caller forwards awake-time accounting only when `counted` came back
 * true. Best-effort: an unreachable control plane returns `counted: false`
 * (losing a touch costs a relaunch later, never this turn).
 */
export async function touchBrowserSession(args: {
  sessionId: string;
  kind: "command" | "panel";
  signal?: AbortSignal;
}): Promise<{ counted: boolean }> {
  const raw = await postServiceAuthorized(
    TOUCH_PATH,
    { sessionId: args.sessionId, kind: args.kind },
    args.signal,
  );
  return { counted: isRecord(raw) && raw.counted === true };
}

/**
 * How a relaunch claim can fail to be taken.
 *
 * `claimed` is an ANSWER: another replica is relaunching this box right now,
 * and the caller must not proceed. `unavailable` is the absence of one — an
 * unconfigured deployment, a transport failure, or a control plane that
 * predates the route — and the caller proceeds exactly as it did before the
 * claim existed. Collapsing the two would either brick every relaunch on a
 * backend that has not deployed yet, or let a real conflict through.
 */
export type BrowserRelaunchClaim =
  { ok: true } | { ok: false; reason: "claimed" | "unavailable" };

/**
 * Take the exclusive right to relaunch this computer's browser.
 *
 * Held across the `pkill` and the boot, and given back once the session is
 * recorded. The lease fence cannot do this job: the race it misses is exactly
 * the one where there is no daemon yet to hold a lease on, and the record
 * compare-and-swap cannot either, because it fires long after the kill.
 */
export async function claimBrowserRelaunch(args: {
  computerId: string;
  /** This attempt's identity; only it may release the claim. */
  claimId: string;
  ttlMs?: number;
  signal?: AbortSignal;
}): Promise<BrowserRelaunchClaim> {
  const raw = await postServiceAuthorized(
    RELAUNCH_CLAIM_PATH,
    {
      computerId: args.computerId,
      claimId: args.claimId,
      ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }),
    },
    args.signal,
  );
  // 409 is the route's "somebody else has it" and arrives as the shared
  // conflict sentinel; `null` is every other non-answer.
  if (raw === CONFLICT) return { ok: false, reason: "claimed" };
  if (!isRecord(raw)) return { ok: false, reason: "unavailable" };
  return { ok: true };
}

/**
 * Give the relaunch claim back.
 *
 * Best-effort and never throws: a claim that is not released expires on its
 * own, which is the whole reason it has a TTL. Refusing to finish a relaunch
 * because the release call failed would turn a slow network into a wedged box.
 */
export async function releaseBrowserRelaunch(args: {
  computerId: string;
  claimId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postServiceAuthorized(
    RELAUNCH_RELEASE_PATH,
    { computerId: args.computerId, claimId: args.claimId },
    args.signal,
  ).catch(() => null);
}
