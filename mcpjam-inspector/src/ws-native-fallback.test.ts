import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("ws-native-fallback", () => {
  const saved = {
    bufferUtil: process.env.WS_NO_BUFFER_UTIL,
    utf8Validate: process.env.WS_NO_UTF_8_VALIDATE,
  };

  beforeEach(() => {
    delete process.env.WS_NO_BUFFER_UTIL;
    delete process.env.WS_NO_UTF_8_VALIDATE;
  });

  afterEach(() => {
    process.env.WS_NO_BUFFER_UTIL = saved.bufferUtil;
    process.env.WS_NO_UTF_8_VALIDATE = saved.utf8Validate;
  });

  it("sets both `ws` native-fallback vars to a truthy value on import", async () => {
    await import("./ws-native-fallback.js");

    // `ws` gates on `!process.env.X`, so the value only has to be non-empty.
    expect(process.env.WS_NO_BUFFER_UTIL).toBeTruthy();
    expect(process.env.WS_NO_UTF_8_VALIDATE).toBeTruthy();
  });

  it("is the first import in main.ts", () => {
    // GUARDRAIL. `ws` reads these at module-eval time, so the assignment only
    // wins if nothing that pulls `ws` in is imported first. Ordering is the
    // whole fix, and no type or bundle check can see it (#4208).
    const main = readFileSync(resolve(__dirname, "main.ts"), "utf8");
    const firstImport = main
      .split("\n")
      .find((line) => line.startsWith("import "));

    expect(firstImport).toBe('import "./ws-native-fallback.js";');
  });
});
