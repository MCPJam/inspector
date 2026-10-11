import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A startup failure in telemetry must never prevent the app from opening. */
export function loadSentryInstallationId(userData: string): string {
  const file = join(userData, ".sentry-installation-id");
  const read = () => {
    const id = readFileSync(file, "utf8").trim();
    return UUID.test(id) ? id : undefined;
  };
  try {
    const existing = read();
    if (existing) return `installation:${existing}`;
  } catch {
    /* Missing or unreadable file: use a new random ID. */
  }

  const id = randomUUID();
  const temporary = `${file}.${id}.tmp`;
  try {
    mkdirSync(userData, { recursive: true });
    try {
      writeFileSync(file, id, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = read();
      if (existing) return `installation:${existing}`;
      writeFileSync(temporary, id, { flag: "wx", mode: 0o600 });
      renameSync(temporary, file);
    }
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      /* Best effort cleanup. */
    }
  }
  return `installation:${id}`;
}
