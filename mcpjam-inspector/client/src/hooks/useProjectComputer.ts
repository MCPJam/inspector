import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";

/**
 * Client hooks for the Project Computers control plane (mcpjam-backend
 * `convex/projectComputers.ts`). The inspector references Convex functions by
 * string id (it does not import the backend's generated `api`).
 */

/** Provider-side lifecycle status surfaced by `getComputerStatus`. */
export type ComputerStatus =
  | "requested"
  | "provisioning"
  | "ready"
  | "waking"
  | "hibernating"
  | "deleting"
  | "deleted"
  | "error";

/** Why a computer is currently asleep, when the backend knows (COMP-7). */
export type ComputerHibernatedReason = "idle" | "billing";

export interface ComputerView {
  computerId: string;
  status: ComputerStatus;
  provider: string;
  lastError?: string;
  provisionedAt?: number;
  lastActiveAt?: number;
  /** The custom environment this computer boots from, if any (absent ⇒ base
   * image). See `computerEnvironments` / the Image picker. */
  environmentId?: string;
  /**
   * Why the machine is currently asleep, when known (COMP-7). Only meaningful
   * while `status === "hibernating"`. `"billing"` ⇒ paused because the compute
   * allowance ran out and the wallet couldn't cover the overage — waking it
   * would just bounce, so the UI shows the remedy instead. Absent (older
   * backends, or a clean idle sleep) ⇒ treat as inactivity.
   */
  hibernatedReason?: ComputerHibernatedReason;
}

export interface TerminalTokenResult {
  token: string;
  expiresAt: number;
  computerId: string;
  status: ComputerStatus;
}

/**
 * Org-level awake-time meter surfaced by `getComputerUsage`: settled awake
 * time for the current UTC month against the plan's free allowance, plus the
 * posted credits-per-hour rate. `allowanceMs: null` means unlimited hours.
 * `mode` is the deployment's billing posture — `off` means the backend isn't
 * metering and the UI should hide the meter.
 */
export interface ComputerUsageView {
  mode: "off" | "shadow" | "enforce";
  creditsPerHour: number;
  windowStartAt: number;
  resetsAt: number;
  awakeMs: number;
  allowanceMs: number | null;
  billedCredits: number;
  forgivenCredits: number;
  /**
   * COMP-7: true when the org has burned >= 80% of a finite allowance AND the
   * wallet can't absorb the overage that begins once it's exhausted — i.e. the
   * computer will pause for billing when the hours run out. Always false for
   * unlimited (enterprise) orgs. Optional so a backend predating this field
   * (or an older client) degrades to "no warning".
   */
  billingPauseWarning?: boolean;
}

/**
 * Live status of the caller's computer for a project, or `null` when they
 * have none (or it was deleted). `undefined` while the query loads or when
 * `projectId` is absent.
 */
export function useComputerStatus(
  projectId: string | null
): ComputerView | null | undefined {
  return useQuery(
    "projectComputers:getComputerStatus" as never,
    projectId ? ({ projectId } as never) : "skip"
  ) as ComputerView | null | undefined;
}

/**
 * The org's computer-time meter for a project, or `null` when the backend
 * can't resolve it. `undefined` while loading or when `projectId` is absent.
 * Throws during render (like any Convex query error) against a backend that
 * predates `getComputerUsage` — mount it behind an error boundary.
 */
export function useComputerUsage(
  projectId: string | null
): ComputerUsageView | null | undefined {
  return useQuery(
    "projectComputers:getComputerUsage" as never,
    projectId ? ({ projectId } as never) : "skip"
  ) as ComputerUsageView | null | undefined;
}

/** Reserve (provision-on-first-use / wake) the caller's computer. */
export function useReserveComputer(): (args: {
  projectId: string;
}) => Promise<ComputerView> {
  return useMutation("projectComputers:getOrReserveComputer" as never) as never;
}

/** Tear down the caller's computer for a project. */
export function useDeleteComputer(): (args: {
  projectId: string;
}) => Promise<{ deleted: boolean }> {
  return useMutation("projectComputers:deleteComputer" as never) as never;
}

/**
 * Manually hibernate the caller's `ready` computer (non-destructive; state is
 * preserved and the box auto-resumes on next use). Returns `{ hibernated:false }`
 * when there's no live machine to pause.
 */
export function useHibernateComputer(): (args: {
  projectId: string;
}) => Promise<{ hibernated: boolean }> {
  return useMutation("projectComputers:hibernateComputerNow" as never) as never;
}

/**
 * Mint a short-lived (~60s) terminal token authorizing a WebSocket to the
 * inspector server's terminal bridge. An ACTION (needs crypto.subtle).
 */
export function useMintTerminalToken(): (args: {
  projectId: string;
}) => Promise<TerminalTokenResult> {
  return useAction("projectComputers:mintTerminalToken" as never) as never;
}

/**
 * Mint a short-lived (~60s) BROWSER token authorizing the Browser Panel's
 * data-plane calls. Separate from the terminal token on purpose: it resolves
 * the desktop computer, and its `purpose` claim means a terminal token cannot
 * be replayed to open a live view of someone's screen.
 */
export function useMintBrowserToken(): (args: {
  projectId: string;
}) => Promise<TerminalTokenResult> {
  return useAction("projectComputers:mintBrowserToken" as never) as never;
}

/**
 * Which data plane serves this inspector (GET /api/web/computers/config):
 * itself (`localConfigured` — it holds the vendor key + secrets) or a
 * deployed one (`remoteDataPlaneUrl`). Neither ⇒ computers are unavailable
 * here and the UI should say so instead of offering a terminal that can't
 * connect.
 */
export interface ComputerEnginesConfig {
  local: {
    available: boolean;
    /** Bash may work while the terminal doesn't (node-pty failed to load). */
    terminalAvailable: boolean;
    /** Tilde display root ("~/.mcpjam/computer") — render `${root}/<projectId>`. */
    workspaceDisplayRoot: string | null;
    reason?: string;
  };
  cloud: { available: boolean };
}

export interface ComputersDataPlaneConfig {
  localConfigured: boolean;
  remoteDataPlaneUrl: string | null;
  /**
   * Can this inspector EXECUTE in ephemeral (eval/swarm/scenario) sandboxes?
   * Distinct from personal-computer availability: `remoteDataPlaneUrl`
   * delegates only personal bash/terminal, so a remote-only inspector can
   * drive a personal Computer yet cannot run a single disposable-sandbox
   * command. Read from the server's `capabilities.ephemeralCloudAvailable`
   * when present; older servers omit it and the derivation falls back to
   * `localConfigured` (creds present ⇔ ephemeral exec works).
   */
  ephemeralCloudAvailable?: boolean;
  /**
   * Per-engine availability. Always present POST-PARSE: servers that predate
   * the field get a derived block — local unavailable (an old server has no
   * local engine to offer), cloud from the legacy pair — so consumers never
   * branch on absence.
   */
  engines: ComputerEnginesConfig;
  /** Server's suggested engine; `null` when NO engine can serve here. */
  defaultEngine: "local" | "cloud" | null;
}

/** The legacy-pair derivation, shared by old-server parse and fallbacks. */
function deriveEnginesFromLegacyPair(args: {
  localConfigured: boolean;
  remoteDataPlaneUrl: string | null;
}): Pick<ComputersDataPlaneConfig, "engines" | "defaultEngine"> {
  const cloudAvailable =
    args.localConfigured || args.remoteDataPlaneUrl !== null;
  return {
    engines: {
      local: {
        available: false,
        terminalAvailable: false,
        workspaceDisplayRoot: null,
      },
      cloud: { available: cloudAvailable },
    },
    defaultEngine: cloudAvailable ? "cloud" : null,
  };
}

// One fetch per page load — the answer is env-derived and can't change
// without a server restart.
let cachedDataPlaneConfig: ComputersDataPlaneConfig | null = null;
// Concurrent first mounts (e.g. suite view + suite header) share one request
// instead of racing duplicate fetches to the same env-derived answer.
let inFlightDataPlaneConfigFetch: Promise<ComputersDataPlaneConfig | null> | null =
  null;

function parseEngines(value: unknown): ComputerEnginesConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const local =
    record.local && typeof record.local === "object"
      ? (record.local as Record<string, unknown>)
      : null;
  const cloud =
    record.cloud && typeof record.cloud === "object"
      ? (record.cloud as Record<string, unknown>)
      : null;
  if (
    !local ||
    !cloud ||
    typeof local.available !== "boolean" ||
    typeof cloud.available !== "boolean"
  ) {
    return null;
  }
  return {
    local: {
      available: local.available,
      terminalAvailable: local.terminalAvailable === true,
      workspaceDisplayRoot:
        typeof local.workspaceDisplayRoot === "string"
          ? local.workspaceDisplayRoot
          : null,
      ...(typeof local.reason === "string" ? { reason: local.reason } : {}),
    },
    cloud: { available: cloud.available },
  };
}

function parseDataPlaneConfig(value: unknown): ComputersDataPlaneConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.localConfigured !== "boolean") return null;
  const localConfigured = record.localConfigured;
  const remoteDataPlaneUrl =
    typeof record.remoteDataPlaneUrl === "string"
      ? record.remoteDataPlaneUrl
      : null;
  const capabilities =
    record.capabilities && typeof record.capabilities === "object"
      ? (record.capabilities as Record<string, unknown>)
      : undefined;
  // A malformed `engines` block is read like an OLD server (derive), never
  // half-trusted — a partial parse could invent a local engine.
  const engines = parseEngines(record.engines);
  const derived = deriveEnginesFromLegacyPair({
    localConfigured,
    remoteDataPlaneUrl,
  });
  return {
    localConfigured,
    remoteDataPlaneUrl,
    ...(typeof capabilities?.ephemeralCloudAvailable === "boolean"
      ? { ephemeralCloudAvailable: capabilities.ephemeralCloudAvailable }
      : {}),
    engines: engines ?? derived.engines,
    defaultEngine: engines
      ? record.defaultEngine === "local" || record.defaultEngine === "cloud"
        ? record.defaultEngine
        : null
      : derived.defaultEngine,
  };
}

/**
 * Preflight bit for the cloud-only surfaces (swarms / evals / user testing):
 * `false` means a run that needs a disposable sandbox WILL fail to execute
 * commands on this inspector, and the UI should say so before launch instead
 * of after. `undefined` while the config is loading.
 *
 * Fail-open on transient /config failures (the per-mount fallback assumes a
 * local data plane) — a flaky fetch must not paint scary banners on a
 * perfectly configured deployment; a genuine `false` only comes from a real
 * server answer.
 */
export function useEphemeralCloudAvailable(): boolean | undefined {
  const config = useComputersDataPlaneConfig();
  if (config === undefined) return undefined;
  return config.ephemeralCloudAvailable ?? config.localConfigured;
}

/** `undefined` while loading. On fetch failure assumes a local data plane —
 * the pre-config behavior, where the terminal WS surfaces the real error. */
export function useComputersDataPlaneConfig():
  | ComputersDataPlaneConfig
  | undefined {
  const [config, setConfig] = useState<ComputersDataPlaneConfig | undefined>(
    cachedDataPlaneConfig ?? undefined
  );

  useEffect(() => {
    if (cachedDataPlaneConfig) return;
    let cancelled = false;
    // Only cache real answers. The assume-local fallback below is per-mount,
    // so a transient /config failure can't pin the wrong data plane for the
    // rest of the SPA session. The in-flight promise IS shared (deduped), but
    // it resolves `null` on failure so each mount applies its own fallback.
    inFlightDataPlaneConfigFetch ??= fetch("/api/web/computers/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => {
        const parsed = parseDataPlaneConfig(json);
        if (parsed) cachedDataPlaneConfig = parsed;
        return parsed;
      })
      .catch(() => null)
      .finally(() => {
        inFlightDataPlaneConfigFetch = null;
      });
    void inFlightDataPlaneConfigFetch.then((parsed) => {
      if (!cancelled) {
        // Legacy fail-open fallback: assume a local data plane (cloud engine
        // served by this server), NEVER a phantom local machine engine.
        setConfig(
          parsed ?? {
            localConfigured: true,
            remoteDataPlaneUrl: null,
            ...deriveEnginesFromLegacyPair({
              localConfigured: true,
              remoteDataPlaneUrl: null,
            }),
          }
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
