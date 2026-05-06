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

/**
 * Hard cap on retry attempts so a permanent error (billing limit reached,
 * forbidden, validation) doesn't spam the console every 30s forever. After
 * this many retries the hook stops scheduling new ones; the user can still
 * trigger a fresh attempt by reloading the tab.
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Convex error codes that the migration cannot recover from by retrying.
 * If any per-project failure carries one of these codes, the hook treats
 * the whole batch as terminal — no retry, no log spam. The user reloads
 * (or fixes the underlying account state) to try again.
 */
const PERMANENT_ERROR_CODES = new Set([
  "billing_limit_reached",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

function looksPermanent(errorMessage: string): boolean {
  for (const code of PERMANENT_ERROR_CODES) {
    if (errorMessage.includes(code)) return true;
  }
  return false;
}

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
  const retryCountRef = useRef(0);
  const [retryTick, setRetryTick] = useState(0);
  const createProject = useMutation("projects:createProject" as any);

  useEffect(() => {
    // Per-effect-run cancel flag. The migration is async — the component can
    // unmount (or the effect can re-run on dep change) while the promise is
    // still in flight. Without this flag, the trailing `.then/.catch/.finally`
    // would call `scheduleRetry()` after unmount, scheduling a `setTimeout`
    // that the cleanup function has already had its chance to clear. Result:
    // an orphaned 30s timer that fires after the component is gone and calls
    // `setRetryTick` on a dead instance.
    let cancelled = false;

    // Defined inside the effect so it closes over the same `logger` reference
    // the effect itself uses. Hoisting it to the component body would let the
    // async .then/.catch callbacks reach a stale `logger` if `useLogger`
    // returns a new object on a subsequent render.
    const scheduleRetry = (): void => {
      if (cancelled) return;
      if (retryTimerRef.current !== null) return;
      if (retryCountRef.current >= MAX_RETRY_ATTEMPTS) {
        logger.warn(
          "Local state migration retry limit reached; will not retry until reload",
          { attempts: retryCountRef.current },
        );
        doneRef.current = true;
        return;
      }
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        setRetryTick((t) => t + 1);
      }, RETRY_DELAY_MS);
    };

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
      return () => {
        cancelled = true;
      };
    }

    inFlightRef.current = true;
    runLocalStateMigration({
      createProject: createProject as any,
      organizationId,
      logger,
    })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          doneRef.current = true;
          if (result.projectsMigrated > 0) {
            logger.info("Local state migration completed", {
              projectsMigrated: result.projectsMigrated,
            });
          }
          return;
        }
        // Permanent backend errors (billing limit, forbidden, validation)
        // won't recover by retrying. Mark done so the user can fix the
        // account state and reload, instead of retrying every 30s.
        const hasPermanentError = result.errors.some((e) =>
          looksPermanent(e.error),
        );
        if (hasPermanentError) {
          logger.error(
            "Local state migration hit a permanent error; not retrying",
            { errors: result.errors },
          );
          doneRef.current = true;
          return;
        }
        logger.warn(
          "Local state migration partially failed; scheduling retry",
          {
            errors: result.errors,
            retryDelayMs: RETRY_DELAY_MS,
            attempt: retryCountRef.current + 1,
          },
        );
        scheduleRetry();
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (looksPermanent(message)) {
          logger.error(
            "Local state migration threw a permanent error; not retrying",
            { error: message },
          );
          doneRef.current = true;
          return;
        }
        logger.error("Local state migration threw; scheduling retry", {
          error: message,
          retryDelayMs: RETRY_DELAY_MS,
          attempt: retryCountRef.current + 1,
        });
        scheduleRetry();
      })
      .finally(() => {
        inFlightRef.current = false;
        releaseMigrationLease();
      });

    return () => {
      // Block any trailing async resolutions from scheduling new work, and
      // clear the retry timer if one was already scheduled. The other refs
      // (`inFlightRef`, `doneRef`) intentionally persist so a re-mount or a
      // dep-change re-run picks up where we left off.
      cancelled = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [
    isAuthenticated,
    isUserBootstrapping,
    organizationId,
    createProject,
    logger,
    retryTick,
  ]);
}
