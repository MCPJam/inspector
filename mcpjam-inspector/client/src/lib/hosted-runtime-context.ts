import type {
  EnvironmentOverrides,
  HostedExecutionTarget,
} from "@/shared/execution-target";

export type HostedAccessErrorDetail = {
  status: number;
  code?: string;
  message: string;
};

/**
 * Outcome of a re-redeem attempt.
 *
 * `denied` is the only terminal reason: the backend definitively refused to
 * re-mint a grant. `transient` (network blip, rate limiter, 5xx) and
 * `no_token` both mean "nothing changed" — the caller surfaces the original
 * error and the next send gets a fresh attempt.
 */
export type HostedAccessRecoveryResult =
  | { ok: true; accessVersion: number }
  | {
      ok: false;
      reason: "no_token" | "denied" | "transient";
      error?: HostedAccessErrorDetail;
    };

export type HostedRuntimeContext = {
  projectId?: string | null;
  selectedServerIds?: string[];
  oauthTokens?: Record<string, string>;
  /**
   * Saved host being previewed (Playground / host-bound direct chat). Absent
   * for non-host direct chat and for published-chatbox sessions (which carry
   * `chatboxId` instead). Forwarded as `hostId` on direct-session request
   * bodies so the server re-resolves the host's authoritative runtime config
   * (incl. harness/computer); also part of the session scope so switching the
   * previewed host forks the chat session.
   */
  hostId?: string;
  /**
   * The host this surface PRESENTS as (Playground's previewed host). Purely a
   * client-side cache key — it is never put on the request wire, never part of
   * the session scope, and makes no statement about what executes.
   *
   * It exists because an environment target deliberately omits `hostId` (the
   * server re-resolves the host from the environment), which left client caches
   * keyed by host — the harness workdir cache the Playground Shell reads —
   * writing under the project fallback while the reader looked under the
   * environment's resolved host id, so the terminal opened outside the harness
   * session directory. In host mode this is simply the same value as `hostId`.
   */
  presentationHostId?: string | null;
  /**
   * Project Environments (Phase 2). What this session executes against, as ONE
   * serializable pointer. Mutually exclusive with `hostId` and `chatboxId`:
   * `normalizeExecutionTarget` REJECTS a body carrying both rather than picking
   * a winner, so a surface that sets an environment target must stop sending
   * `hostId` (the environment's host is still fine to use for *presentation* —
   * model chip, harness built-ins — it just must not be a second statement
   * about what to run).
   *
   * Absent ⇒ unchanged legacy behavior (`hostId` / `chatboxId` / ad-hoc).
   */
  executionTarget?: HostedExecutionTarget;
  /**
   * Per-turn narrowing of an environment's server set. Sent ONLY when the user
   * explicitly overrode the environment: `undefined` means "follow the
   * environment", `{ serverIds: [] }` means "run with no MCP servers", and the
   * backend keeps those distinct. Never inferred from `selectedServerIds` —
   * that field describes the UI selection, not override intent.
   *
   * Only meaningful alongside an `executionTarget` of kind `"environment"`;
   * ingress rejects it otherwise.
   */
  environmentOverrides?: EnvironmentOverrides;
  /**
   * Resolved chatbox identity (post-redeem). Threaded into every
   * chatbox-aware request body and cache key.
   */
  chatboxId?: string;
  accessVersion?: number;
  chatboxSurface?: "preview" | "share_link";
  /**
   * Silent re-redeem trigger. Called when a chatbox-aware Convex mutation
   * reports `chatbox_access_stale` — the owner re-runs
   * /web/chatbox/redeem and updates `accessVersion` in place so dependent
   * flows can retry without a page reload.
   */
  requestRefreshAccessVersion?: () => void;
  /**
   * Awaitable re-redeem, for callers that must know the outcome before they
   * decide what to do next (the chat turn's recovery + replay). Resolves
   * only AFTER the new session has been committed to React state and
   * storage, so the returned `accessVersion` is the one downstream reads
   * will see.
   *
   * Single-flight: concurrent callers — N chat lanes plus the widget-capture
   * backoff — share ONE /redeem round trip rather than each minting their own
   * grant and racing to write the session.
   *
   * Never rejects; a failure is reported in the result so the caller can
   * distinguish "try again later" (transient) from "this visitor is out"
   * (denied).
   */
  refreshAccessSession?: () => Promise<HostedAccessRecoveryResult>;
  /**
   * Terminal access loss: recovery ran and the visitor still cannot reach
   * this chatbox. The page owner tears the runtime down to the denied
   * landing (which carries the Sign in / Open in App affordances) instead of
   * leaving a generic error banner over a chat that can no longer send.
   */
  onAccessRevoked?: (error: HostedAccessErrorDetail) => void;
  /**
   * True for published-chatbox runtime sessions (bootstrapped via
   * /api/web/chatboxes/redeem). Their server set is Convex-resolved by
   * id, so the turn must flow through /api/web/chat-v2 (with authFetch)
   * on every platform — the local /api/mcp engine has no way to connect
   * attachment servers and would silently run the chat without tools.
   * Playground builder previews stay platform-routed: in local mode they
   * reuse the builder's locally-connected servers.
   */
  requiresWebChatApi?: boolean;
  /**
   * Preflight that resolves selected runtime server NAMES → persisted Convex
   * server ids (persisting ad-hoc/App servers that aren't saved yet), awaited
   * before a hosted harness send so the proxy/authorize-batch never receive a
   * display name. Provided by Playground-class surfaces from
   * `useServerActions().ensureHostedServerIdsForNames`; absent for surfaces
   * whose servers are already Convex-resolved (e.g. chatbox), which keep the
   * existing pre-resolved `selectedServerIds` path. Throws on an unresolvable
   * name so the caller fails the send closed.
   */
  ensureServerIds?: (
    serverNames: string[],
  ) => Promise<Array<{ serverName: string; serverId: string }>>;
};
