import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSessionToken } from "../session-token.js";
import { writeInspectorRuntime } from "../inspector-runtime.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
describe("local Inspector discovery", () => {
  it("writes private discovery and does not delete a replacement instance", () => {
    const home = mkdtempSync(join(tmpdir(), "inspector-runtime-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const token = generateSessionToken();
    const cleanup = writeInspectorRuntime(6274, { home });
    cleanups.push(cleanup);
    const file = join(home, ".mcpjam/inspector/6274.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      port: 6274,
      pid: process.pid,
      token,
    });
    generateSessionToken();
    const replacement = writeInspectorRuntime(6274, { home });
    cleanups.push(replacement);
    cleanup();
    expect(existsSync(file)).toBe(true);
    replacement();
    expect(existsSync(file)).toBe(false);
  });
  it("never writes hosted credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "inspector-hosted-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    writeInspectorRuntime(6274, { home, hosted: true })();
    expect(existsSync(join(home, ".mcpjam"))).toBe(false);
  });
  it("warns and continues when the home cannot contain a runtime directory", () => {
    const home = mkdtempSync(join(tmpdir(), "inspector-unwritable-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, ".mcpjam"), "not a directory");
    const token = generateSessionToken();
    const warn = vi.fn();
    expect(() =>
      writeInspectorRuntime(6274, { home, docker: false, warn })(),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(
      "local CLI attachment is unavailable",
    );
    expect(warn.mock.calls[0][0]).not.toContain(token);
  });
  it("skips discovery in Docker even without a writable home", () => {
    const home = mkdtempSync(join(tmpdir(), "inspector-docker-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const warn = vi.fn();
    writeInspectorRuntime(6274, { home, docker: true, warn })();
    expect(existsSync(join(home, ".mcpjam"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
