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
  /** The box the session named is gone, hibernating, or never live. */
  | "box_unavailable";

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
  contextMode: "persistent" | "ephemeral";
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
}

const LOOKUP_PATH = "/browser-runtime/session/lookup";
const RECORD_PATH = "/browser-runtime/session/record";
const TOUCH_PATH = "/browser-runtime/session/touch";

/** Above the backend's own latency and far below any turn deadline. */
const REQUEST_TIMEOUT_MS = 10_000;

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

  // `addEventListener("abort")` never fires on a signal that already aborted.
  if (signal?.aborted) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(new URL(path, base).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
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
 * Is there a plausibly-live daemon for this computer at exactly this bundle?
 * Staleness is the backend's verdict; daemon liveness is then re-verified by
 * the caller against `/v1/status` — the row alone never admits.
 */
export async function lookupBrowserSession(args: {
  computerId: string;
  expectedBundleHash: string;
  signal?: AbortSignal;
}): Promise<BrowserSessionLookup> {
  const raw = await postServiceAuthorized(
    LOOKUP_PATH,
    {
      computerId: args.computerId,
      expectedBundleHash: args.expectedBundleHash,
    },
    args.signal,
  );
  if (!isRecord(raw)) return { reachable: false, session: null };
  const stale = raw.stale;
  return {
    reachable: true,
    session: parseSession(raw.session),
    ...(stale === "bundle_changed" || stale === "box_unavailable"
      ? { stale }
      : {}),
  };
}

/**
 * Publish a freshly booted daemon. Replaces any prior session for the same
 * computer.
 *
 * `null` means the record did not land — the caller must then STOP the daemon
 * it just booted and refuse, because an unrecorded runtime is one no replica
 * can later find, and its stream password is one nothing can ever recover.
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
  contextMode: "persistent" | "ephemeral";
  signal?: AbortSignal;
}): Promise<string | null> {
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
    },
    args.signal,
  );
  if (!isRecord(raw) || typeof raw.sessionId !== "string") return null;
  return raw.sessionId;
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
