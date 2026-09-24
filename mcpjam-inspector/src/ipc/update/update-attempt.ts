import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UpdateFailureReason } from "../../../shared/desktop-update.js";

export const RELAUNCH_MARKER_MAX_AGE_MS = 15 * 60_000;
export type UpdateAttempt = {
  schema: 1;
  id: string;
  at: number;
  fromVersion: string;
  targetVersion?: string;
  phase: "downloading" | "recovering" | "installing" | "failed";
  retries: 0 | 1;
  userRequested: boolean;
  reported: string[];
  failure?: UpdateFailureReason;
};

const reasons: UpdateFailureReason[] = [
  "updater_error",
  "download_timeout",
  "no_update",
  "install_refused",
  "install_threw",
  "install_timeout",
  "shutdown_stuck",
  "restart_failed",
  "recovery_expired",
  "marker_invalid",
  "marker_write_failed",
  "version_unchanged",
];

// Release names are display text, not trustworthy version identifiers. Only
// persist/emit normalized versions; never copy arbitrary feed strings to Sentry.
export function updateVersion(value: string): string | undefined {
  return /^(?:Release\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(
    value,
  )?.[1];
}

export function newAttempt(version: string): UpdateAttempt {
  return {
    schema: 1,
    id: randomUUID(),
    at: Date.now(),
    fromVersion: updateVersion(version) ?? "unknown",
    phase: "downloading",
    retries: 0,
    userRequested: false,
    reported: [],
  };
}

export function attemptPath(userData: string): string {
  // Reuse the old marker location. Old count-only records are deliberately
  // treated as invalid: they cannot prove which version the user authorized.
  return path.join(userData, ".install-update-on-relaunch");
}

export function saveAttempt(file: string, attempt: UpdateAttempt): boolean {
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(attempt), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

export function removeAttempt(file: string): boolean {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readAttempt(
  file: string,
):
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "expired"; attempt: UpdateAttempt }
  | { kind: "valid"; attempt: UpdateAttempt } {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      kind:
        (error as NodeJS.ErrnoException)?.code === "ENOENT"
          ? "none"
          : "invalid",
    };
  }
  if (!value || typeof value !== "object") return { kind: "invalid" };
  const a = value as UpdateAttempt;
  if (
    a.schema !== 1 ||
    typeof a.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(a.id) ||
    !Number.isFinite(a.at) ||
    a.at > Date.now() ||
    typeof a.fromVersion !== "string" ||
    (a.fromVersion !== "unknown" &&
      updateVersion(a.fromVersion) !== a.fromVersion) ||
    (a.targetVersion !== undefined &&
      (typeof a.targetVersion !== "string" ||
        updateVersion(a.targetVersion) !== a.targetVersion)) ||
    !["downloading", "recovering", "installing", "failed"].includes(a.phase) ||
    (a.retries !== 0 && a.retries !== 1) ||
    typeof a.userRequested !== "boolean" ||
    !Array.isArray(a.reported) ||
    a.reported.length > 32 ||
    !a.reported.every(
      (key) => typeof key === "string" && /^(0|1):[a-z_]+:[a-z_]+$/.test(key),
    ) ||
    (a.failure !== undefined && !reasons.includes(a.failure)) ||
    (a.phase === "failed" && !a.failure)
  )
    return { kind: "invalid" };
  if (Date.now() - a.at > RELAUNCH_MARKER_MAX_AGE_MS)
    return { kind: "expired", attempt: a };
  return { kind: "valid", attempt: a };
}

function compareVersions(left: string, right: string): number {
  const [leftCore, leftPre] = left.split("+")[0].split(/-(.*)/);
  const [rightCore, rightPre] = right.split("+")[0].split(/-(.*)/);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] - rightParts[i];
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const a = leftPre.split(".");
  const b = rightPre.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric && bNumeric) return Number(a[i]) - Number(b[i]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function installedVersionMatches(
  a: UpdateAttempt,
  running: string,
): boolean {
  const version = updateVersion(running);
  if (!version) return false;
  // A different build label or a downgrade must not masquerade as success.
  if (
    a.fromVersion !== "unknown" &&
    compareVersions(version, a.fromVersion) <= 0
  )
    return false;
  return !a.targetVersion || compareVersions(version, a.targetVersion) >= 0;
}
