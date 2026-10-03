import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/electron/main";
import log from "electron-log";
import {
  installedVersionMatches,
  newAttempt,
  updateVersion,
  type UpdateAttempt,
} from "./update-attempt.js";

type Outcome = "installed" | "not_installed" | "unknown";
type Pending = {
  id: string;
  failureEventId: string;
  outcomeEventId: string;
  fromVersion: string;
  targetVersion?: string;
  observed?: { outcome: Outcome; version: string; at: number };
};
const filename = (userData: string) =>
  path.join(userData, ".update-install-outcomes.json");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const eventId = /^[0-9a-f]{32}$/;
const version = (v: unknown) =>
  typeof v === "string" && (v === "unknown" || updateVersion(v) === v);
function read(userData: string): Pending[] | undefined {
  const file = filename(userData);
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.warn("Could not read update outcome journal");
    return undefined;
  }
  try {
    const rows: unknown = JSON.parse(contents);
    if (
      !Array.isArray(rows) ||
      rows.length > 32 ||
      !rows.every(
        (r) =>
          r &&
          uuid.test(r.id) &&
          eventId.test(r.failureEventId) &&
          eventId.test(r.outcomeEventId) &&
          version(r.fromVersion) &&
          (r.targetVersion === undefined ||
            (typeof r.targetVersion === "string" &&
              updateVersion(r.targetVersion) === r.targetVersion)) &&
          (r.observed === undefined ||
            (["installed", "not_installed", "unknown"].includes(
              r.observed.outcome,
            ) &&
              version(r.observed.version) &&
              Number.isSafeInteger(r.observed.at) &&
              r.observed.at >= 0)),
      )
    )
      throw new Error("invalid outcome journal");
    return rows as Pending[];
  } catch {
    log.warn("Invalid update outcome journal");
    try {
      fs.renameSync(file, `${file}.invalid`);
    } catch {
      log.warn("Could not quarantine invalid update outcome journal");
    }
    return undefined;
  }
}
function write(userData: string, rows: Pending[]): boolean {
  try {
    fs.writeFileSync(filename(userData) + ".tmp", JSON.stringify(rows), {
      mode: 0o600,
    });
    fs.renameSync(filename(userData) + ".tmp", filename(userData));
    return true;
  } catch {
    log.warn("Could not write update outcome journal");
    return false;
  }
}
// Separate from the recovery marker: this never grants restart/install permission.
export function rememberInstallFailure(
  userData: string,
  attempt: UpdateAttempt,
): string | undefined {
  const rows = read(userData);
  if (!rows) return;
  const previous = rows.find((r) => r.id === attempt.id);
  if (previous) return; // Keep the first failure as the thread anchor.
  if (rows.length === 32) {
    log.warn("Update outcome journal is full");
    return;
  }
  const row: Pending = {
    id: attempt.id,
    failureEventId: randomUUID().replaceAll("-", ""),
    outcomeEventId: randomUUID().replaceAll("-", ""),
    fromVersion: attempt.fromVersion,
    ...(attempt.targetVersion ? { targetVersion: attempt.targetVersion } : {}),
  };
  return write(userData, [...rows, row]) ? row.failureEventId : undefined;
}
export async function reportPendingInstallResults(
  userData: string,
  running: string,
): Promise<void> {
  const rows = read(userData);
  if (!rows?.length) return;
  for (const row of rows) {
    if (row.observed) continue;
    const current = updateVersion(running);
    const known = current && row.fromVersion !== "unknown" && row.targetVersion;
    const attempt = {
      ...newAttempt(row.fromVersion),
      targetVersion: row.targetVersion,
    };
    row.observed = {
      outcome: !known
        ? "unknown"
        : installedVersionMatches(attempt, running)
          ? "installed"
          : "not_installed",
      version: current ?? "unknown",
      at: Date.now(),
    };
  }
  // Freeze the FIRST launch result before network I/O; an offline launch must
  // not later be reported as a different version after another update.
  if (!write(userData, rows)) return;
  try {
    for (const row of rows) {
      const observed = row.observed!;
      const tags = {
        component: "desktop-updater",
        update_notification: "outcome",
        update_reason: "install_outcome",
        update_attempt_id: row.id,
      };
      Sentry.withScope((scope) => {
        scope.addEventProcessor((event) => ({
          ...event,
          user: undefined,
          request: undefined,
          extra: undefined,
          breadcrumbs: [],
          tags,
          contexts: { update: event.contexts?.update },
        }));
        Sentry.captureEvent({
          event_id: row.outcomeEventId,
          message:
            observed.outcome === "installed"
              ? "Update installed"
              : observed.outcome === "not_installed"
                ? "Update wasn’t installed on this launch"
                : "Couldn’t verify the update",
          level: "info",
          fingerprint: ["desktop-update-install-outcome"],
          tags,
          contexts: {
            update: {
              attempt_id: row.id,
              failure_event_id: row.failureEventId,
              install_outcome: observed.outcome,
              from_version: row.fromVersion,
              target_version: row.targetVersion,
              running_version: observed.version,
              observed_at: observed.at,
            },
          },
        });
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delivered = false;
    try {
      delivered = await Promise.race([
        Sentry.flush(2000),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (delivered) {
      // New failures may have been appended while flush was in progress.
      const current = read(userData);
      if (current)
        write(
          userData,
          current.filter(
            (r) =>
              !rows.some((sent) => sent.outcomeEventId === r.outcomeEventId),
          ),
        );
    }
  } catch {
    log.warn(
      "Could not report update install outcome; retained for next launch",
    );
  }
}
