/**
 * Client side of the local-harness consent CAPABILITY, and of the runtime
 * operation that has to finish before there is anything to consent to.
 *
 * The server (`/api/mcp/local-harness/*`) is the authority: grant mints a token
 * whose HASH it persists, and re-derives every identity in the binding from
 * what it can prove rather than from what the caller claimed. This module
 * stores the plaintext in `localStorage` and rides it on a chat turn in the
 * `x-mcpjam-local-harness-grant` header, where `resolveLocalHarnessAvailability`
 * re-verifies it against the terms it independently resolved.
 *
 * That server-side re-verification is the real enforcement point, so the CLIENT
 * treats a stored token as consent and does NOT pre-verify. The local-computer
 * twin learned this the expensive way: a verify-on-mount loop racing grant,
 * revoke, and the same-tab storage event grew five race guards for zero safety,
 * because a stale or tampered token simply fails the next turn's server check.
 * localStorage is the single source of truth here, read synchronously.
 *
 * ── Why every call returns a TYPED result ────────────────────────────────
 * These used to answer `null` for everything: a 401, a 403, a 409, a network
 * failure and a malformed body were one value. The UI could then only say
 * "something went wrong", and the one state that most needed a specific
 * recovery — 409 `consent-context-changed`, meaning what you approved is no
 * longer what would run — was indistinguishable from a dropped connection. So
 * each call answers a discriminated union, and the caller decides what to say.
 *
 * ── What is stored, and why it is scoped this way ────────────────────────
 * Per PROJECT, unlike the local-computer consent, which is per device. The
 * thing consented to here is not "this machine may run commands" but "this
 * agent may work in THIS directory for THIS project", and those are different
 * decisions a user should be able to make differently.
 *
 * Stored alongside the token are the opaque ids a turn has to send back and the
 * display strings the UI shows. No absolute path is ever among them: the server
 * returns a tilde-shortened display root and nothing else.
 */
import { authFetch } from "@/lib/session-token";

const STORAGE_PREFIX = "mcp-local-harness-consent-v1";
const EVENT_NAME = "local-harness-consent-changed";

/**
 * Header carrying the consent capability on a local-target chat turn.
 *
 * A header rather than a body field so it cannot enter a persisted transcript —
 * the same reasoning as the local-computer consent, and the same casing rule
 * (the server reads it case-insensitively; this is canonical).
 */
export const LOCAL_HARNESS_GRANT_HEADER = "X-MCPJam-Local-Harness-Grant";

/** The opaque target ids a turn sends in its body. Never a path, never a key. */
export interface LocalHarnessTargetIds {
  kind: "local-native";
  harnessId: string;
  machineId: string;
  workspaceGrantId: string;
  runtimeId: string;
  permissionProfile: string;
  policyVersion: string;
}

export interface StoredLocalHarnessConsent {
  grantId: string;
  token: string;
  expiresAt: string;
  target: LocalHarnessTargetIds;
  /** `~/code/project`. Display only — the server never returns an absolute path. */
  workspaceDisplayRoot: string;
  runtime: {
    runtimeId: string;
    adapterVersion: string;
    digest: string;
    packVersion: string;
  };
  grantedAt: string;
}

/**
 * The storage key, EXPORTED.
 *
 * The hook used to build `mcp-local-harness-consent-v1:${projectId}` from its
 * own copy of the literal, so a change here silently stopped it subscribing to
 * the thing it was reading. One owner of the shape.
 */
export function localHarnessConsentStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

/**
 * The raw stored string, for a `useSyncExternalStore` snapshot.
 *
 * A primitive rather than a parsed object, because the store compares snapshots
 * by identity and a fresh object every read is an infinite render loop.
 */
export function readLocalHarnessConsentSnapshot(
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  try {
    return localStorage.getItem(localHarnessConsentStorageKey(projectId));
  } catch {
    return null;
  }
}

export function loadStoredLocalHarnessConsent(
  projectId: string,
): StoredLocalHarnessConsent | null {
  try {
    const raw = localStorage.getItem(localHarnessConsentStorageKey(projectId));
    return parseStoredLocalHarnessConsent(raw);
  } catch {
    return null;
  }
}

/**
 * Parse and validate a stored record, including expiry.
 *
 * Exported so the hook can re-derive from a snapshot string it already holds
 * — and, crucially, so an expiry TIMER can force a re-parse. Re-reading the
 * same storage string cannot notice that time passed; only re-running this
 * can, because the expiry comparison is here.
 */
export function parseStoredLocalHarnessConsent(
  raw: string | null,
  now: number = Date.now(),
): StoredLocalHarnessConsent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredLocalHarnessConsent | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.token !== "string" || parsed.token.length < 16) {
      return null;
    }
    if (!parsed.target || typeof parsed.target.runtimeId !== "string") {
      return null;
    }
    // An expired grant is not consent. The server would refuse it anyway; not
    // sending it means the UI shows the dialog instead of a turn that fails on
    // arrival.
    if (
      typeof parsed.expiresAt === "string" &&
      Number.isFinite(Date.parse(parsed.expiresAt)) &&
      Date.parse(parsed.expiresAt) <= now
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Returns whether the write actually landed (storage can be disabled or full). */
function persist(
  projectId: string,
  consent: StoredLocalHarnessConsent | null,
): boolean {
  try {
    if (consent) {
      localStorage.setItem(
        localHarnessConsentStorageKey(projectId),
        JSON.stringify(consent),
      );
    } else {
      localStorage.removeItem(localHarnessConsentStorageKey(projectId));
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
    return true;
  } catch {
    return false;
  }
}

export function subscribeLocalHarnessConsent(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_PREFIX)) callback();
  };
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", onStorage);
  };
}

function localHarnessRequest(
  path: string,
  body?: unknown,
  method: "GET" | "POST" = "POST",
): Promise<Response> {
  // `authFetch` attaches BOTH the inspector session header and the verified
  // bearer (the path is in `HOSTED_AUTH_PATH_PREFIXES`). Setting Authorization
  // here would trip its caller-provided guard and disable the on-401 session
  // refresh, leaving these stuck at 401 after a dev-server restart.
  return authFetch(`/api/mcp/local-harness/${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

/**
 * Why a local-harness call did not succeed.
 *
 * Each of these leads somewhere different, which is the whole reason they are
 * separate values: `unauthenticated` and `forbidden` end at a sign-in prompt,
 * `unavailable` at "this Inspector cannot do this", `conflict` at a dialog
 * that re-asks with fresh terms, and `network` at Retry.
 */
export type LocalHarnessErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "unavailable"
  | "network"
  | "malformed";

export interface LocalHarnessError {
  ok: false;
  kind: LocalHarnessErrorKind;
  status: number | null;
  message: string;
  /** The server's own typed reason, when it sent one. */
  reason?: string;
  /** Extra detail for a `conflict`, so a dialog can re-render without a fetch. */
  detail?: unknown;
}

function errorFromStatus(
  status: number,
  body: { error?: unknown; reason?: unknown; message?: unknown } | null,
): LocalHarnessError {
  const message =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : `the request failed (${status})`;
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const kind: LocalHarnessErrorKind =
    status === 401
      ? "unauthenticated"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not-found"
          : status === 409
            ? "conflict"
            : status === 503
              ? "unavailable"
              : "malformed";
  return {
    ok: false,
    kind,
    status,
    message,
    ...(reason ? { reason } : {}),
    ...(body ? { detail: body } : {}),
  };
}

const NETWORK_ERROR = (message: string): LocalHarnessError => ({
  ok: false,
  kind: "network",
  status: null,
  message,
});

async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface LocalHarnessRuntimeStatus {
  state:
    | "absent"
    | "downloading"
    | "verifying"
    | "ready"
    | "corrupt"
    | "failed"
    | "interrupted"
    | "unsupported-platform";
  packVersion?: string;
  percent?: number;
  message?: string;
  reason?: "network" | "verification" | "disk" | "unknown";
  attemptId?: string;
  runtimeRoot?: string;
  digest?: string;
}

export interface LocalHarnessAvailabilityView {
  available: boolean;
  status: string;
  message: string | null;
  platform: string;
  machineId: string | null;
  keyFingerprint: string | null;
  permissionProfile: string;
  policyVersion: string;
  runtime: {
    runtimeId: string;
    adapterVersion: string;
    digest: string;
    vendorPackages: Record<string, string>;
  } | null;
  runtimeStatus: LocalHarnessRuntimeStatus;
  runtimeRootConfigured: boolean;
  /**
   * Is a CLOUD execution target infrastructurally available on this server?
   *
   * Narrow on purpose: it says the computers data plane is configured, not
   * that any given model or host is eligible for it. The client needs this one
   * bit to know whether "This machine" is a CHOICE (show a picker) or simply
   * what this Inspector is (show an indicator).
   */
  hostedAvailable: boolean;
  /** The runtime this build expects, whether or not one is installed. */
  expectedPack: { packVersion: string; treeDigest: string } | null;
  /** The folder the user launched from, display-only. Null ⇒ ask. */
  suggestedWorkspace: { displayRoot: string } | null;
}

export type LocalHarnessAvailabilityResult =
  | { ok: true; availability: LocalHarnessAvailabilityView }
  | LocalHarnessError;

export async function fetchLocalHarnessAvailability(): Promise<LocalHarnessAvailabilityResult> {
  let response: Response;
  try {
    response = await localHarnessRequest("availability", undefined, "GET");
  } catch (error) {
    return NETWORK_ERROR(
      error instanceof Error ? error.message : "the request failed",
    );
  }
  if (!response.ok) {
    return errorFromStatus(response.status, await readJsonBody(response));
  }
  const body = await readJsonBody(response);
  if (body === null) {
    return { ok: false, kind: "malformed", status: 200, message: "unreadable" };
  }
  return { ok: true, availability: body as unknown as LocalHarnessAvailabilityView };
}

export type LocalHarnessRuntimeStatusResult =
  | { ok: true; status: LocalHarnessRuntimeStatus }
  | LocalHarnessError;

/**
 * Read the runtime's state. Never starts work.
 *
 * `verify: true` asks the more expensive question — is the installed tree
 * still the one that was verified? — which the polling loop must not use and
 * the pre-consent check must.
 */
export async function fetchLocalHarnessRuntimeStatus(
  options: { verify?: boolean } = {},
): Promise<LocalHarnessRuntimeStatusResult> {
  let response: Response;
  try {
    response = await localHarnessRequest(
      options.verify === true ? "runtime/status?verify=1" : "runtime/status",
      undefined,
      "GET",
    );
  } catch (error) {
    return NETWORK_ERROR(
      error instanceof Error ? error.message : "the request failed",
    );
  }
  if (!response.ok) {
    return errorFromStatus(response.status, await readJsonBody(response));
  }
  const body = await readJsonBody(response);
  if (body === null) {
    return { ok: false, kind: "malformed", status: 200, message: "unreadable" };
  }
  return { ok: true, status: body as unknown as LocalHarnessRuntimeStatus };
}

export type StartLocalHarnessInstallResult =
  /** 202 — work is running here or in another Inspector. Poll. */
  | {
      ok: true;
      kind: "accepted";
      attemptId?: string;
      status: LocalHarnessRuntimeStatus;
      statusUrl: string;
      retryAfterSeconds: number;
    }
  /** 200 — a verified runtime is already installed. Nothing was downloaded. */
  | { ok: true; kind: "ready"; status: LocalHarnessRuntimeStatus }
  | LocalHarnessError;

/**
 * Ask the server to install the runtime, and AWAIT the acknowledgement.
 *
 * Not fire-and-forget. A POST whose response nobody reads is a POST whose
 * refusal nobody sees — and the two refusals here are exactly the ones a user
 * must not miss: a session that cannot authorize this, and an approved pack
 * that is no longer the pack this build expects.
 *
 * `expectedPack` is what the user was SHOWN. The server compares it before
 * downloading and answers 409 rather than fetching a different runtime under
 * the same approval.
 */
export async function startLocalHarnessRuntimeInstall(args: {
  expectedPack?: { packVersion: string; treeDigest: string } | null;
} = {}): Promise<StartLocalHarnessInstallResult> {
  let response: Response;
  try {
    response = await localHarnessRequest("runtime/install", {
      ...(args.expectedPack ? { expectedPack: args.expectedPack } : {}),
    });
  } catch (error) {
    return NETWORK_ERROR(
      error instanceof Error ? error.message : "the request failed",
    );
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    return errorFromStatus(response.status, body);
  }
  // A body with no usable runtime state is not a successful install.
  // `(body?.status ?? {})` reported one anyway: the caller stored `{}` as the
  // runtime status, phase derivation read `undefined` off it, and the UI
  // settled somewhere between "installing" and "ready" on the strength of a
  // response that never said either.
  const rawStatus = body?.status;
  if (
    typeof rawStatus !== "object" ||
    rawStatus === null ||
    typeof (rawStatus as { state?: unknown }).state !== "string"
  ) {
    return {
      ok: false,
      kind: "malformed",
      status: response.status,
      message: "the install response carried no runtime status",
    };
  }
  const status = rawStatus as LocalHarnessRuntimeStatus;
  if (response.status === 200 || body?.state === "ready") {
    return { ok: true, kind: "ready", status };
  }
  return {
    ok: true,
    kind: "accepted",
    ...(typeof body?.attemptId === "string" ? { attemptId: body.attemptId } : {}),
    status,
    statusUrl:
      typeof body?.statusUrl === "string"
        ? body.statusUrl
        : "/api/mcp/local-harness/runtime/status",
    retryAfterSeconds:
      typeof body?.retryAfterSeconds === "number" ? body.retryAfterSeconds : 1,
  };
}

export type RegisterWorkspaceResult =
  | { ok: true; workspaceGrantId: string; displayRoot: string }
  | LocalHarnessError;

/**
 * Register a workspace directory.
 *
 * Two shapes, and never both. `{ path }` is the Electron picker's choice
 * (arriving over IPC from the main process) or the npx user's own typed value
 * on their own loopback server. `{ useSuggested: true }` names the folder the
 * launcher recorded — the client cannot send that one as a path, because it is
 * never told the absolute path in the first place.
 */
export async function registerLocalHarnessWorkspace(
  selection: { path: string } | { useSuggested: true },
): Promise<RegisterWorkspaceResult> {
  let response: Response;
  try {
    response = await localHarnessRequest("workspace-grant", selection);
  } catch (error) {
    return NETWORK_ERROR(
      error instanceof Error ? error.message : "the request failed",
    );
  }
  const body = await readJsonBody(response);
  if (!response.ok) return errorFromStatus(response.status, body);
  if (
    typeof body?.workspaceGrantId !== "string" ||
    typeof body?.displayRoot !== "string"
  ) {
    return {
      ok: false,
      kind: "malformed",
      status: response.status,
      message: "the workspace grant response was unreadable",
    };
  }
  return {
    ok: true,
    workspaceGrantId: body.workspaceGrantId,
    displayRoot: body.displayRoot,
  };
}

/** The terms a user approved, sent back for the server to compare. */
export interface LocalHarnessConsentExpectations {
  machineId: string;
  packVersion: string;
  treeDigest: string;
  permissionProfile: string;
  policyVersion: string;
}

export type MintConsentResult =
  | { ok: true; consent: StoredLocalHarnessConsent }
  /** 409: what was approved is no longer what would run. */
  | (LocalHarnessError & {
      kind: "conflict";
      changed?: string[];
      current?: Partial<LocalHarnessConsentExpectations>;
    })
  | LocalHarnessError;

/**
 * Mint a consent capability on the SERVER, without persisting it locally.
 *
 * Split from the persist step for the same reason the local-computer twin is:
 * the network wait stays OUT of any "my own write" guard, so an external revoke
 * arriving mid-mint stays visible. The caller re-checks its own approval and
 * context BEFORE persisting what comes back.
 */
export async function mintLocalHarnessConsent(args: {
  projectId: string;
  workspaceGrantId: string;
  /** What the user was shown. Omitted ⇒ asking for the terms, not confirming. */
  expect?: LocalHarnessConsentExpectations;
}): Promise<MintConsentResult> {
  let response: Response;
  try {
    response = await localHarnessRequest("consent/grant", {
      projectId: args.projectId,
      workspaceGrantId: args.workspaceGrantId,
      ...(args.expect ? { expect: args.expect } : {}),
    });
  } catch (error) {
    return NETWORK_ERROR(
      error instanceof Error ? error.message : "the request failed",
    );
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    const failure = errorFromStatus(response.status, body);
    if (failure.kind === "conflict") {
      return {
        ...failure,
        ...(Array.isArray(body?.changed)
          ? { changed: body.changed as string[] }
          : {}),
        ...(body?.current
          ? { current: body.current as Partial<LocalHarnessConsentExpectations> }
          : {}),
      };
    }
    return failure;
  }
  const json = (body ?? {}) as Partial<StoredLocalHarnessConsent>;
  if (typeof json.token !== "string" || json.token.length < 16) {
    return {
      ok: false,
      kind: "malformed",
      status: response.status,
      message: "the grant response carried no usable capability",
    };
  }
  if (!json.target || !json.grantId || !json.runtime) {
    return {
      ok: false,
      kind: "malformed",
      status: response.status,
      message: "the grant response was incomplete",
    };
  }
  return {
    ok: true,
    consent: {
      grantId: json.grantId,
      token: json.token,
      expiresAt: json.expiresAt ?? "",
      target: json.target,
      workspaceDisplayRoot: json.workspaceDisplayRoot ?? "",
      runtime: json.runtime,
      grantedAt: new Date().toISOString(),
    },
  };
}

export function persistLocalHarnessConsent(
  projectId: string,
  consent: StoredLocalHarnessConsent,
): boolean {
  return persist(projectId, consent);
}

/**
 * Forget & re-authorize.
 *
 * Clears the local record whatever the server says: a user who clicked this
 * must not be left with a token the UI still treats as consent because a
 * network call failed. The server-side revoke is the authoritative half, and
 * the grant's own TTL is the backstop if it never lands.
 */
export async function revokeLocalHarnessConsent(
  projectId: string,
): Promise<void> {
  const stored = loadStoredLocalHarnessConsent(projectId);
  persist(projectId, null);
  try {
    await localHarnessRequest(
      "consent/revoke",
      stored ? { grantId: stored.grantId } : {},
    );
  } catch {
    // Already forgotten locally; the TTL and the server's own sweep finish it.
  }
}

/**
 * Revoke ONE grant id, without touching local storage.
 *
 * For the late-result case: a grant arrives after its approval was cancelled,
 * so that specific capability has to be destroyed — but a grant somebody else
 * minted in the meantime, and the stored record it produced, must survive.
 * Clearing storage here would be the cancel silently revoking a newer, valid
 * authorization.
 */
export async function revokeLocalHarnessGrantId(
  grantId: string,
): Promise<void> {
  try {
    await localHarnessRequest("consent/revoke", { grantId });
  } catch {
    // The grant's TTL is the backstop. It was never persisted here.
  }
}

/** The local brake: stop every local harness session this server owns. */
export async function stopAllLocalHarnessSessions(): Promise<boolean> {
  try {
    const response = await localHarnessRequest("stop-all", {});
    return response.ok;
  } catch {
    return false;
  }
}
