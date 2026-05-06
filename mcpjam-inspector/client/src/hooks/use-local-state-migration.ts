import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import {
  hasMigrationCompleted,
  runLocalStateMigration,
} from "@/lib/local-state-migration";
import { HOSTED_MODE } from "@/lib/config";
import { useLogger } from "./use-logger";

interface UseLocalStateMigrationOptions {
  /** True when Convex auth has resolved (signed-in user OR guest). */
  isAuthenticated: boolean;
  /**
   * Optional org id to migrate into. Undefined defers to Convex's
   * resolveProjectOrganizationId which falls back to the actor's default
   * organization (provisioned by `users:ensureUser`).
   */
  organizationId?: string;
}

/**
 * Runs the legacy-localStorage → Convex migration exactly once per install.
 *
 * Skips when:
 *   - HOSTED_MODE (hosted users never had localStorage state)
 *   - The migration flag is already set
 *   - Convex auth hasn't resolved
 *   - Migration is already in flight (prevents duplicate fires across renders)
 */
export function useLocalStateMigration({
  isAuthenticated,
  organizationId,
}: UseLocalStateMigrationOptions): void {
  const logger = useLogger("LocalStateMigration");
  const inFlightRef = useRef(false);
  const doneRef = useRef(false);
  const createProject = useMutation("projects:createProject" as any);

  useEffect(() => {
    if (HOSTED_MODE) return;
    if (!isAuthenticated) return;
    if (doneRef.current) return;
    if (inFlightRef.current) return;
    if (hasMigrationCompleted()) {
      doneRef.current = true;
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
          logger.warn("Local state migration partially failed; will retry", {
            errors: result.errors,
          });
        }
      })
      .catch((error) => {
        logger.error("Local state migration threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [isAuthenticated, organizationId, createProject, logger]);
}
