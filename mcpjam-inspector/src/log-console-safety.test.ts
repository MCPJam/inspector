import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { retireConsoleOnStreamError } from "./log-console-safety";

const epipe = () =>
  Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });

describe("retireConsoleOnStreamError", () => {
  // The failure is delivered as an `'error'` EVENT on the stream, not thrown
  // out of the log call — so that is what these emit.
  it("retires the console transport when stdout errors", () => {
    const transport = { level: "debug" as unknown };
    const stdout = new EventEmitter();

    retireConsoleOnStreamError(transport, [stdout]);
    stdout.emit("error", epipe());

    expect(transport.level).toBe(false);
  });

  it("guards stderr too, which is where warn and error lines go", () => {
    const transport = { level: "debug" as unknown };
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    retireConsoleOnStreamError(transport, [stdout, stderr]);
    stderr.emit("error", epipe());

    expect(transport.level).toBe(false);
  });

  it("makes the error survivable rather than an unhandled 'error' event", () => {
    // An EventEmitter with no 'error' listener THROWS on emit — the in-process
    // shape of the crash. With the guard it must not.
    const stdout = new EventEmitter();
    expect(() => stdout.emit("error", epipe())).toThrow();

    retireConsoleOnStreamError({ level: "debug" }, [stdout]);
    expect(() => stdout.emit("error", epipe())).not.toThrow();
  });

  it("leaves the transport alone until something actually fails", () => {
    const transport = { level: "debug" as unknown };
    retireConsoleOnStreamError(transport, [new EventEmitter()]);
    expect(transport.level).toBe("debug");
  });

  it("reports retirement once, however many writes fail after it", () => {
    // Reproduced: the event fires on every write to a dead pipe.
    const onRetire = vi.fn();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    retireConsoleOnStreamError({ level: "debug" }, [stdout, stderr], onRetire);
    stdout.emit("error", epipe());
    stdout.emit("error", epipe());
    stderr.emit("error", epipe());

    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it("retires before reporting, so the report cannot reach the dead console", () => {
    const transport = { level: "debug" as unknown };
    const stdout = new EventEmitter();
    let levelSeenByReport: unknown = "not called";

    retireConsoleOnStreamError(transport, [stdout], () => {
      levelSeenByReport = transport.level;
    });
    stdout.emit("error", epipe());

    expect(levelSeenByReport).toBe(false);
  });

  it("retires on any stream error, not only EPIPE", () => {
    // A console that errors is unusable whatever the errno.
    const transport = { level: "debug" as unknown };
    const stdout = new EventEmitter();

    retireConsoleOnStreamError(transport, [stdout]);
    stdout.emit(
      "error",
      Object.assign(new Error("EBADF: bad file descriptor"), { code: "EBADF" }),
    );

    expect(transport.level).toBe(false);
  });
});

/**
 * The same failure on a real pipe, in a real child process.
 *
 * This is the test the first version of the fix lacked. It threw from a fake
 * `writeFn`, the tests passed, and the guard could not have worked: on a real
 * pipe `console.info` never throws, and the EPIPE arrives as a stream event.
 *
 * `unguarded` is the control. Without it, a passing `guarded` run could just
 * mean the child never hit a broken pipe at all.
 */
describe("on a real closed pipe", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "epipe-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function runChild(mode: "guarded" | "unguarded") {
    const report = path.join(dir, `${mode}.txt`);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(__dirname, "test-fixtures", "epipe-child.ts"),
        report,
        mode,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    // The reader goes away, as when the launcher of a packaged build exits.
    child.stdout.destroy();

    return new Promise<{ code: number | null; report: string }>((resolve) => {
      child.on("exit", (code) => {
        let text = "";
        try {
          text = readFileSync(report, "utf8");
        } catch {
          // No report at all is itself a result.
        }
        resolve({ code, report: text });
      });
    });
  }

  it("dies of an uncaught EPIPE without the guard", async () => {
    const { code, report } = await runChild("unguarded");
    expect(code).toBe(3);
    expect(report).toContain("uncaught EPIPE");
  });

  it("survives with the guard, and stops writing to the console", async () => {
    const { code, report } = await runChild("guarded");
    expect(code).toBe(0);
    expect(report).toContain("retired EPIPE");
    expect(report).toContain("finished level=false");
    expect(report).not.toContain("uncaught");
  });
});
