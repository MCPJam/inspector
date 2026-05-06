import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  hasMigrationCompleted,
  runLocalStateMigration,
} from "@/lib/local-state-migration";
import { HOSTED_MODE } from "@/lib/config";
import { useLogger } from "./use-logger";

/**
 * localStorage key holding a short-lived lease (timestamp ms) so two
 * inspector tabs opened before either marks the migration complete don't
 * both call `projects:createProject` for the same legacy project. The lease
 * is bounded by `MIGRATION_LEASE_TTL_MS` so a tab that crashed mid-migration
 * doesn't block another tab forever.
 */
const MIGRATION_LEASE_KEY = "mcp-inspector-migration-lease";
const MIGRATION_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Backoff used when a migration attempt returns `ok: false` (e.g., Convex
 * was briefly unreachable, or one project failed) or the cross-tab lease
 * is currently held. Without an explicit retry trigger the `useEffect`
 * dependencies are stable and the failed migration would effectively wait
 * for a page reload.
 */
const RETRY_DELAY_MS = 30 * 1000;

interface UseLocalStateMigrationOptions {
  /** True when Convex auth has resolved (signed-in user OR guest). */
  isAuthenticated: boolean;
  /**
   * True while `users:ensureUser` is still running. The migration depends
   * on the actor's `users` row + default org existing in Convex; firing
   * before bootstrap can race the row creation and surface as a
   * `createProject` failure with no automatic retry. Wait until this is
   * false before attempting migration.
   */
  isUserBootstrapping: boolean;
  /**
   * Optional org id to migrate into. Undefined defers to Convex's
   * resolveProjectOrganizationId which falls back to the actor's default
   * organization (provisioned by `users:ensureUser`).
   */
  organizationId?: string;
}

function tryAcquireMigrationLease(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const now = Date.now();
    const existing = localStorage.getItem(MIGRATION_LEASE_KEY);
    if (existing) {
      const ts = Number(existing);
      if (Number.isFinite(ts) && now - ts < MIGRATION_LEASE_TTL_MS) {
        return false;
      }
    }
    localStorage.setItem(MIGRATION_LEASE_KEY, String(now));
    return true;
  } catch {
    // localStorage blocked — caller falls back to in-memory ref guard.
    return true;
  }
}

function releaseMigrationLease(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(MIGRATION_LEASE_KEY);
  } catch {
    // best-effort
  }
}

/**
 * Runs the legacy-localStorage → Convex migration exactly once per install.
 *
 * Skips when:
 *   - HOSTED_MODE (hosted users never had localStorage state)
 *   - The migration flag is already set
 *   - Convex auth hasn't resolved
 *   - User bootstrap (`users:ensureUser`) is still running
 *   - Migration is already in flight (in-tab) or another tab holds the lease
 *
 * On `ok: false` (partial failure) or contention with another tab,
 * schedules a retry tick after `RETRY_DELAY_MS`. Because `useMutation`
 * returns a stable reference and the gate inputs rarely change, the prior
 * "retry on next render" approach effectively waited for a page reload —
 * the explicit tick state forces the effect to re-evaluate.
 */
export function useLocalStateMigration({
  isAuthenticated,
  isUserBootstrapping,
  organizationId,
}: UseLocalStateMigrationOptions): void {
  const logger = useLogger("LocalStateMigration");
  const inFlightRef = useRef(false);
  const doneRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const createProject = useMutation("projects:createProject" as any);

  const scheduleRetry = (): void => {
    if (retryTimerRef.current !== null) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      setRetryTick((t) => t + 1);
    }, RETRY_DELAY_MS);
  };

  useEffect(() => {
    if (HOSTED_MODE) return;
    if (!isAuthenticated) return;
    if (isUserBootstrapping) return;
    if (doneRef.current) return;
    if (inFlightRef.current) return;
    if (hasMigrationCompleted()) {
      doneRef.current = true;
      return;
    }

    if (!tryAcquireMigrationLease()) {
      logger.info("Another tab holds the migration lease; will retry", {
        retryDelayMs: RETRY_DELAY_MS,
      });
      scheduleRetry();
      return;
    }

    inFlightRef.current = true;
    runLocalStateMigration({
      createProject: createProject as any,
      organizationId,
      logger,
    })
      .then((result) => {
        if (result.ok) {
          doneRef.current = true;
          if (result.projectsMigrated > 0) {
            logger.info("Local state migration completed", {
              projectsMigrated: result.projectsMigrated,
            });
          }
        } else {
          logger.warn(
            "Local state migration partially failed; scheduling retry",
            { errors: result.errors, retryDelayMs: RETRY_DELAY_MS },
          );
          scheduleRetry();
        }
      })
      .catch((error) => {
        logger.error("Local state migration threw; scheduling retry", {
          error: error instanceof Error ? error.message : String(error),
          retryDelayMs: RETRY_DELAY_MS,
        });
        scheduleRetry();
      })
      .finally(() => {
        inFlightRef.current = false;
        releaseMigrationLease();
      });
  }, [
    isAuthenticated,
    isUserBootstrapping,
    organizationId,
    createProject,
    logger,
    retryTick,
  ]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);
}
