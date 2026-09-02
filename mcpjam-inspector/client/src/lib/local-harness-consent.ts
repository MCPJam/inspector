/**
 * Client side of the local-harness consent CAPABILITY.
 *
 * The server (`/api/mcp/local-harness/consent/*`) is the authority: grant mints
 * a token whose HASH it persists, and re-derives every identity in the binding
 * from what it can prove rather than from what the caller claimed. This module
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

function storageKey(projectId: string): string {
  // Per-project keys rather than one map: a shared record means every project's
  // consent is rewritten whenever one changes, and a partial write loses the
  // others. The local-computer engine's storage module made the same choice.
  return `${STORAGE_PREFIX}:${projectId}`;
}

export function loadStoredLocalHarnessConsent(
  projectId: string,
): StoredLocalHarnessConsent | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLocalHarnessConsent | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.token !== "string" || parsed.token.length < 16) {
      return null;
    }
    if (!parsed.target || typeof parsed.target.runtimeId !== "string") {
      return null;
    }
    // An expired grant is not consent. The server would refuse it anyway; not
    // sending it means the UI shows the consent sheet instead of a turn that
    // fails on arrival.
    if (
      typeof parsed.expiresAt === "string" &&
      Number.isFinite(Date.parse(parsed.expiresAt)) &&
      Date.parse(parsed.expiresAt) <= Date.now()
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
      localStorage.setItem(storageKey(projectId), JSON.stringify(consent));
    } else {
      localStorage.removeItem(storageKey(projectId));
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
  runtimeStatus: {
    state:
      | "absent"
      | "downloading"
      | "verifying"
      | "ready"
      | "corrupt"
      | "unsupported-platform";
    packVersion?: string;
    percent?: number;
    message?: string;
  };
}

export async function fetchLocalHarnessAvailability(): Promise<LocalHarnessAvailabilityView | null> {
  try {
    const response = await localHarnessRequest("availability", undefined, "GET");
    if (!response.ok) return null;
    return (await response.json()) as LocalHarnessAvailabilityView;
  } catch {
    return null;
  }
}

export async function fetchLocalHarnessRuntimeStatus(): Promise<
  LocalHarnessAvailabilityView["runtimeStatus"] | null
> {
  try {
    const response = await localHarnessRequest(
      "runtime/status",
      undefined,
      "GET",
    );
    if (!response.ok) return null;
    return (await response.json()) as LocalHarnessAvailabilityView["runtimeStatus"];
  } catch {
    return null;
  }
}

export async function installLocalHarnessRuntime(): Promise<
  LocalHarnessAvailabilityView["runtimeStatus"] | null
> {
  try {
    const response = await localHarnessRequest("runtime/install", {});
    if (!response.ok) return null;
    return (await response.json()) as LocalHarnessAvailabilityView["runtimeStatus"];
  } catch {
    return null;
  }
}

/**
 * Register a workspace directory.
 *
 * On Electron the path never passes through here: the main-process picker calls
 * the server directly, and this returns whatever it registered. On npx the
 * user's own browser sends the path they typed to their own loopback server,
 * which canonicalizes and re-checks it.
 */
export async function registerLocalHarnessWorkspace(
  path: string,
): Promise<{ workspaceGrantId: string; displayRoot: string } | null> {
  try {
    const response = await localHarnessRequest("workspace-grant", { path });
    if (!response.ok) return null;
    return (await response.json()) as {
      workspaceGrantId: string;
      displayRoot: string;
    };
  } catch {
    return null;
  }
}

/**
 * Mint a consent capability on the SERVER, without persisting it locally.
 *
 * Split from the persist step for the same reason the local-computer twin is:
 * the network wait stays OUT of any "my own write" guard, so an external revoke
 * arriving mid-mint stays visible.
 */
export async function mintLocalHarnessConsent(args: {
  projectId: string;
  workspaceGrantId: string;
}): Promise<StoredLocalHarnessConsent | null> {
  try {
    const response = await localHarnessRequest("consent/grant", {
      projectId: args.projectId,
      workspaceGrantId: args.workspaceGrantId,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<StoredLocalHarnessConsent>;
    if (typeof json.token !== "string" || json.token.length < 16) return null;
    if (!json.target || !json.grantId || !json.runtime) return null;
    return {
      grantId: json.grantId,
      token: json.token,
      expiresAt: json.expiresAt ?? "",
      target: json.target,
      workspaceDisplayRoot: json.workspaceDisplayRoot ?? "",
      runtime: json.runtime,
      grantedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
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

/** The local brake: stop every local harness session this server owns. */
export async function stopAllLocalHarnessSessions(): Promise<boolean> {
  try {
    const response = await localHarnessRequest("stop-all", {});
    return response.ok;
  } catch {
    return false;
  }
}
