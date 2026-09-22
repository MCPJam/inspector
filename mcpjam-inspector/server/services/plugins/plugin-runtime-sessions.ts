/**
 * Durable session records for a plugin's stdio component running inside a
 * sandbox (`pluginRuntimeSessions`, backend `/plugin-runtime/*`).
 *
 * The row is the REACHABILITY GATE, not a cache. Hosted connect refuses every
 * stdio server; the single exception is a server this deployment can prove has
 * a live shim listening for it, and the proof is a session record naming the
 * box, the port and the bearer that shim demands. No row ⇒ the refusal stands.
 * That is why a miss is a NORMAL answer here (`session: null`) rather than an
 * error: "we could not confirm a runtime" and "the lookup broke" lead to the
 * same safe behavior, and neither may be mistaken for admission.
 *
 * Server-to-server only. Every route is authenticated with
 * `INSPECTOR_SERVICE_TOKEN` (the header `x-inspector-service-token`, the same
 * credential `server-secrets.ts` and the computers control plane present),
 * because the record holds a bearer that grants command execution inside a
 * user's VM — a browser must never be able to read or write one.
 */
import { logger } from "../../utils/logger.js";

export type PluginRuntimeBoxKind = "computer" | "sandbox";

/** Why the backend refused to hand back an otherwise-existing session. */
export type PluginRuntimeSessionStale =
  /** The pinned version moved: the shim is running the wrong bundle. */
  | "bundle_changed"
  /** This deployment ships a newer shim than the one that is running. */
  | "shim_outdated"
  /** The box the session named is gone. */
  | "box_unavailable";

export interface PluginRuntimeSessionRecord {
  sessionId: string;
  boxKind: PluginRuntimeBoxKind;
  computerId: string | null;
  sandboxRowId: string | null;
  shimPort: number;
  shimToken: string;
  shimVersion: string;
  bundleHash: string;
}

export interface PluginRuntimeSessionLookup {
  /**
   * Did the control plane actually ANSWER? `false` means the question is
   * unanswered (no config, transport failure, non-2xx, unparseable body), which
   * is different from an answered "there is no session".
   *
   * For ADMISSION the two are the same and deliberately so — neither one
   * admits. They differ only where the answer decides whether a shim may be
   * REAPED: destroying a process because we could not reach the control plane
   * would be acting on an assumption, and the row it belongs to might exist.
   */
  reachable: boolean;
  session: PluginRuntimeSessionRecord | null;
  stale?: PluginRuntimeSessionStale;
}

const LOOKUP_PATH = "/plugin-runtime/session/lookup";
const RECORD_PATH = "/plugin-runtime/session/record";
const TOUCH_PATH = "/plugin-runtime/session/touch";

/** Above the backend's own latency and far below any connect deadline. */
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * POST with the service token, or `null` when this deployment cannot make the
 * call at all (no Convex url, no service token, transport failure, non-2xx).
 * Never throws: every caller's fail-closed answer is the same refusal, and a
 * throw here would turn a degraded control plane into a 500 on a connect that
 * was always going to be refused.
 */
async function postServiceAuthorized(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown | null> {
  const base = process.env.CONVEX_HTTP_URL?.trim();
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN?.trim();
  if (!base || !serviceToken) return null;

  // `addEventListener("abort")` never fires on a signal that already aborted,
  // so a connect abandoned before this call started would otherwise run to the
  // 10s timeout.
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
      logger.warn("[plugin-runtime] session route rejected the request", {
        path,
        status: response.status,
      });
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.warn("[plugin-runtime] session route unreachable", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseSession(raw: unknown): PluginRuntimeSessionRecord | null {
  if (!isRecord(raw)) return null;
  const {
    sessionId,
    boxKind,
    computerId,
    sandboxRowId,
    shimPort,
    shimToken,
    shimVersion,
    bundleHash,
  } = raw;
  if (
    typeof sessionId !== "string" ||
    (boxKind !== "computer" && boxKind !== "sandbox") ||
    typeof shimPort !== "number" ||
    !Number.isInteger(shimPort) ||
    // A port composes a reachable endpoint, so it is as load-bearing as the
    // token below. `0` is a valid ASK (the shim resolves it to a real port) but
    // never a valid ANSWER to store.
    shimPort < 1 ||
    shimPort > 65535 ||
    typeof shimToken !== "string" ||
    shimToken.length === 0 ||
    typeof shimVersion !== "string" ||
    typeof bundleHash !== "string"
  ) {
    // A row we cannot fully read is not a row we may connect through: every
    // field above is load-bearing for reaching the right shim with the right
    // credential.
    return null;
  }
  return {
    sessionId,
    boxKind,
    computerId: typeof computerId === "string" ? computerId : null,
    sandboxRowId: typeof sandboxRowId === "string" ? sandboxRowId : null,
    shimPort,
    shimToken,
    shimVersion,
    bundleHash,
  };
}

/**
 * Is there a live runtime for this server at exactly this bundle and shim?
 * Staleness is the backend's verdict — this deployment does not get to decide
 * that an outdated shim is good enough.
 */
export async function lookupPluginRuntimeSession(args: {
  serverId: string;
  expectedBundleHash: string;
  shimVersion: string;
  signal?: AbortSignal;
}): Promise<PluginRuntimeSessionLookup> {
  const raw = await postServiceAuthorized(
    LOOKUP_PATH,
    {
      serverId: args.serverId,
      expectedBundleHash: args.expectedBundleHash,
      shimVersion: args.shimVersion,
    },
    args.signal
  );
  if (!isRecord(raw)) return { reachable: false, session: null };
  const stale = raw.stale;
  return {
    reachable: true,
    session: parseSession(raw.session),
    ...(stale === "bundle_changed" ||
    stale === "shim_outdated" ||
    stale === "box_unavailable"
      ? { stale }
      : {}),
  };
}

/**
 * Publish a freshly started runtime. Replaces any prior session for the same
 * server, which is what keeps a superseded shim from staying reachable through
 * a record nobody will ever touch again.
 *
 * `null` means the record did not land — the caller must then refuse the
 * connect rather than use the shim it just started, because an unrecorded
 * runtime is one nothing can later find, touch or supersede.
 */
export async function recordPluginRuntimeSession(args: {
  serverId: string;
  pluginVersionId: string;
  projectId: string;
  bundleHash: string;
  boxKind: PluginRuntimeBoxKind;
  computerId?: string;
  sandboxRowId?: string;
  shimPort: number;
  shimToken: string;
  shimVersion: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const raw = await postServiceAuthorized(
    RECORD_PATH,
    {
      serverId: args.serverId,
      pluginVersionId: args.pluginVersionId,
      projectId: args.projectId,
      bundleHash: args.bundleHash,
      boxKind: args.boxKind,
      ...(args.computerId !== undefined ? { computerId: args.computerId } : {}),
      ...(args.sandboxRowId !== undefined
        ? { sandboxRowId: args.sandboxRowId }
        : {}),
      shimPort: args.shimPort,
      shimToken: args.shimToken,
      shimVersion: args.shimVersion,
    },
    args.signal
  );
  if (!isRecord(raw) || typeof raw.sessionId !== "string") return null;
  return raw.sessionId;
}

/** Refresh a reused session's activity. Best-effort: losing the touch costs a
 *  restart later, never this connect. */
export async function touchPluginRuntimeSession(args: {
  sessionId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postServiceAuthorized(
    TOUCH_PATH,
    { sessionId: args.sessionId },
    args.signal
  );
}
