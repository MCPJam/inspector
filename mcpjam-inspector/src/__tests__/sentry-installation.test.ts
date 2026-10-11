import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSentryInstallationId } from "../sentry-installation";

const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "sentry-installation-"));
  dirs.push(dir);
  return dir;
};
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

describe("installation identity", () => {
  it("persists across launches with owner-only permissions", () => {
    const dir = directory();
    const first = loadSentryInstallationId(dir);
    expect(first).toMatch(/^installation:[0-9a-f-]{36}$/);
    expect(loadSentryInstallationId(dir)).toBe(first);
    expect(
      `installation:${readFileSync(join(dir, ".sentry-installation-id"), "utf8")}`,
    ).toBe(first);
    if (process.platform !== "win32")
      expect(statSync(join(dir, ".sentry-installation-id")).mode & 0o777).toBe(
        0o600,
      );
  });
  it("repairs corrupt IDs instead of sending arbitrary content", () => {
    const dir = directory();
    writeFileSync(join(dir, ".sentry-installation-id"), "someone@example.com");
    const id = loadSentryInstallationId(dir);
    expect(id).toMatch(/^installation:[0-9a-f-]{36}$/);
    expect(loadSentryInstallationId(dir)).toBe(id);
  });
  it("returns a random fallback when the storage path cannot be written", () => {
    const dir = directory();
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "occupied");
    expect(loadSentryInstallationId(file)).toMatch(
      /^installation:[0-9a-f-]{36}$/,
    );
    expect(readFileSync(file, "utf8")).toBe("occupied");
  });
});
