import { updateDiagnosticSnapshot } from "./update-diagnostics.js";
import * as Sentry from "@sentry/electron/main";
import { sentryUserId } from "../../../shared/sentry-identity.js";
import log from "electron-log";
import { updateShutdownSnapshot } from "./update-shutdown.js";
import type { UpdateAttempt } from "./update-attempt.js";
import type { UpdateFailureReason } from "../../../shared/desktop-update.js";

export function reportUpdateFailure(
  attempt: UpdateAttempt,
  reason: UpdateFailureReason | "download_recovered" | "install_verified",
  eventId?: string,
): void {
  const key = `${attempt.retries}:${attempt.phase}:${reason}`;
  if (attempt.reported.includes(key)) return;
  attempt.reported.push(key);
  const recovered =
    reason === "download_recovered" || reason === "install_verified";
  const shutdown =
    attempt.phase === "installing" &&
    (reason === "shutdown_stuck" || reason === "install_timeout");
  const message = shutdown
    ? "MCPJam couldn’t close to finish updating. Download completed. Install status: waiting for next launch."
    : recovered
      ? "Desktop update recovered"
      : "Desktop update failed";
  (recovered ? log.info : log.error)(message, {
    reason,
    phase: attempt.phase,
    attemptId: attempt.id,
    retries: attempt.retries,
  });
  const tags = {
    component: "desktop-updater",
    update_stage: attempt.phase,
    update_reason: reason,
    update_attempt_id: attempt.id,
    update_notification: recovered ? "outcome" : "failure",
  };
  try {
    const diagnostics = updateDiagnosticSnapshot(attempt.id);
    try {
      log.info("Desktop update diagnostics", diagnostics);
    } catch {
      /* Continue reporting if the local log fails. */
    }
    // Deliberately construct the event rather than forwarding a native error:
    // those can contain signed feed URLs and paths inside the user's home.
    Sentry.withScope((scope) => {
      // Event processors run after scope merging. Empty fields on captureEvent
      // alone would still inherit OAuth breadcrumbs and identity from the scope.
      scope.addEventProcessor((event) => ({
        ...event,
        breadcrumbs: [],
        user: sentryUserId(event.user),
        server_name: undefined,
        request: undefined,
        extra: undefined,
        tags: {
          ...tags,
          ...(event.tags?.actor_kind
            ? { actor_kind: event.tags.actor_kind }
            : {}),
        },
        contexts: {
          update_diagnostics: diagnostics,
          update: event.contexts?.update,
          update_shutdown: event.contexts?.update_shutdown,
        },
      }));
      Sentry.captureEvent({
        event_id: eventId,
        message,
        level: recovered ? "info" : "error",
        fingerprint: ["desktop-update", attempt.phase, reason],
        tags,
        contexts: {
          update_diagnostics: diagnostics,
          ...(shutdown ? { update_shutdown: updateShutdownSnapshot() } : {}),
          update: {
            attempt_id: attempt.id,
            from_version: attempt.fromVersion,
            target_version: attempt.targetVersion,
            retries: attempt.retries,
            download_retries: attempt.downloadRetries,
            user_requested: attempt.userRequested,
            download_requested: attempt.downloadRequested,
            active_download_ms: attempt.activeDownloadMs,
            sleep_ms: attempt.sleepMs,
            offline_ms: attempt.offlineMs,
            platform: process.platform,
            arch: process.arch,
            elapsed_ms: Math.max(0, Date.now() - attempt.at),
          },
        },
      });
    });
  } catch {
    // Observability must never prevent the user from restarting or quitting.
    log.warn("Could not report desktop update failure");
  }
}

export async function flushUpdateReports(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Sentry.flush(2_000),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } catch {
    // Offline clients can still recover. Sentry owns its transport retry queue.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
