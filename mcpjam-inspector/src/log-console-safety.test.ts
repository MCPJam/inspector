import { describe, expect, it, vi } from "vitest";

import { makeConsoleTransportFailSafe } from "./log-console-safety";

/** The two members the real `log.transports.console` contributes. */
function createTransport(writeFn: (payload: { message: unknown }) => void) {
  return { writeFn, level: "debug" as unknown };
}

const line = { message: { data: ["hello"] } };

describe("makeConsoleTransportFailSafe", () => {
  it("passes a working write straight through, payload untouched", () => {
    const write = vi.fn();
    const transport = createTransport(write);

    makeConsoleTransportFailSafe(transport);
    transport.writeFn(line);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(line);
    expect(transport.level).toBe("debug");
  });

  // INSPECTOR-ELECTRON-WE. On Windows a packaged build's stdout is a pipe, and
  // writing to one nobody reads throws out of `console.info`. electron-log
  // invokes transports bare, so the throw left as an uncaught exception — and
  // with `exitEvenIfOtherHandlersAreRegistered` that ended the app three
  // seconds into launch.
  it("survives a throwing write instead of taking the process down", () => {
    const transport = createTransport(() => {
      throw Object.assign(new Error("EPIPE: broken pipe, write"), {
        code: "EPIPE",
      });
    });

    makeConsoleTransportFailSafe(transport);

    expect(() => transport.writeFn(line)).not.toThrow();
  });

  it("retires the transport after a failure rather than retrying forever", () => {
    // A broken pipe does not heal — the reader is gone for the life of the
    // process. `level = false` is how electron-log skips a transport.
    const transport = createTransport(() => {
      throw new Error("EPIPE: broken pipe, write");
    });

    makeConsoleTransportFailSafe(transport);
    transport.writeFn(line);

    expect(transport.level).toBe(false);
  });

  it("swallows anything the write throws, not only EPIPE", () => {
    // The guard is about the consequence, not the diagnosis: whatever a log
    // write fails with, it must not be what ends the app. Narrowing to one
    // errno would leave the next one fatal.
    const transport = createTransport(() => {
      throw new Error("EACCES: permission denied");
    });

    makeConsoleTransportFailSafe(transport);

    expect(() => transport.writeFn(line)).not.toThrow();
    expect(transport.level).toBe(false);
  });

  it("keeps working for every line until one actually fails", () => {
    let calls = 0;
    const transport = createTransport(() => {
      calls += 1;
      if (calls === 3) throw new Error("EPIPE: broken pipe, write");
    });

    makeConsoleTransportFailSafe(transport);
    transport.writeFn(line);
    transport.writeFn(line);
    expect(transport.level).toBe("debug");

    transport.writeFn(line);
    expect(transport.level).toBe(false);
    expect(calls).toBe(3);
  });
});
