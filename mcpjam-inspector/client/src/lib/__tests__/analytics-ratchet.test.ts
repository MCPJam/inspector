import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Ratchet fence for raw PostHog captures.
 *
 * All NEW analytics calls must go through `client/src/lib/analytics.ts#track`
 * (typed against shared/analytics-events.ts). The legacy raw
 * `posthog.capture(...)` call sites below are frozen: they may be migrated
 * (remove the file from the list when its last raw capture goes), but no new
 * file may add a raw capture.
 *
 * If this test fails because you added `posthog.capture(...)` in a new file:
 * register the event in shared/analytics-events.ts and call track() instead.
 * If it fails because you migrated a file: delete that file's entry from
 * LEGACY_RAW_CAPTURE_FILES — thanks for shrinking the list.
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

const RAW_CAPTURE_PATTERN =
  /\bposthog(\?)?\.capture\(|\bposthogRef\.current(\?)?\.capture\(/;

// The one legitimate raw-capture site.
const ALLOWED_FILES = new Set(["lib/analytics.ts"]);

const LEGACY_RAW_CAPTURE_FILES = new Set<string>([]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__")
        continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("analytics ratchet", () => {
  const offenders = sourceFiles(CLIENT_SRC)
    .filter((file) => RAW_CAPTURE_PATTERN.test(readFileSync(file, "utf8")))
    .map((file) => relative(CLIENT_SRC, file))
    .filter((file) => !ALLOWED_FILES.has(file));

  it("no NEW files call posthog.capture directly — use lib/analytics.ts track()", () => {
    const newOffenders = offenders.filter(
      (file) => !LEGACY_RAW_CAPTURE_FILES.has(file),
    );
    expect(newOffenders).toEqual([]);
  });

  it("migrated files are removed from the legacy list", () => {
    const current = new Set(offenders);
    const stale = [...LEGACY_RAW_CAPTURE_FILES].filter(
      (file) => !current.has(file),
    );
    expect(stale).toEqual([]);
  });
});
