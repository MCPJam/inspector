import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  isDualWrite,
  logGradingEngineModeOnce,
  parseGradingEngineMode,
  producesScoreRows,
  resetGradingEngineModeLogForTests,
  resolveGradingEngineMode,
} from "../grading-mode.js";

// =============================================================================
// The mode resolver is the whole "ships at off" claim in one function, so the
// cases below pin the two properties that claim rests on: an absent or bogus
// env var resolves to `off`, and no other position can ever raise the mode
// above what env allows (monotone `min`, not last-writer-wins).
// =============================================================================

const ENV_KEY = "MCPJAM_GRADING_ENGINE_MODE";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
  resetGradingEngineModeLogForTests();
  vi.restoreAllMocks();
});

describe("parseGradingEngineMode", () => {
  test("recognizes exactly the three positions", () => {
    expect(parseGradingEngineMode("off")).toBe("off");
    expect(parseGradingEngineMode("shadow")).toBe("shadow");
    expect(parseGradingEngineMode("dual_write")).toBe("dual_write");
  });

  test("everything else has no opinion rather than throwing", () => {
    for (const value of [
      undefined,
      null,
      "",
      "DUAL_WRITE",
      "dualWrite",
      "on",
      1,
      {},
    ]) {
      expect(parseGradingEngineMode(value)).toBeUndefined();
    }
  });
});

describe("resolveGradingEngineMode", () => {
  test("defaults to off with no inputs at all", () => {
    delete process.env[ENV_KEY];
    expect(resolveGradingEngineMode()).toBe("off");
  });

  test("an unrecognized env value is off, not an error and not a pass-through", () => {
    expect(resolveGradingEngineMode({ env: "DUAL_WRITE" })).toBe("off");
    expect(resolveGradingEngineMode({ env: "" })).toBe("off");
  });

  test("env is a ceiling: no other position can raise the mode", () => {
    expect(
      resolveGradingEngineMode({
        env: "off",
        orgFlag: { mode: "dual_write" },
        runSnapshot: { mode: "dual_write" },
        runOverride: { mode: "dual_write" },
      })
    ).toBe("off");
    expect(
      resolveGradingEngineMode({
        env: "shadow",
        orgFlag: { mode: "dual_write" },
      })
    ).toBe("shadow");
  });

  test("any single position can lower the mode", () => {
    expect(
      resolveGradingEngineMode({ env: "dual_write", orgFlag: { mode: "off" } })
    ).toBe("off");
    expect(
      resolveGradingEngineMode({
        env: "dual_write",
        runSnapshot: { mode: "shadow" },
      })
    ).toBe("shadow");
    expect(
      resolveGradingEngineMode({
        env: "dual_write",
        orgFlag: { mode: "dual_write" },
        runSnapshot: { mode: "dual_write" },
        runOverride: { mode: "shadow" },
      })
    ).toBe("shadow");
  });

  test("a position with no opinion is unconstrained, not off", () => {
    expect(
      resolveGradingEngineMode({
        env: "dual_write",
        orgFlag: null,
        runSnapshot: { mode: "nonsense" },
        runOverride: undefined,
      })
    ).toBe("dual_write");
  });

  test("reads the env var when the caller passes none", () => {
    process.env[ENV_KEY] = "shadow";
    expect(resolveGradingEngineMode()).toBe("shadow");
  });
});

describe("mode predicates", () => {
  test("only dual_write writes real rows; only off writes none", () => {
    expect(isDualWrite("dual_write")).toBe(true);
    expect(isDualWrite("shadow")).toBe(false);
    expect(isDualWrite("off")).toBe(false);
    expect(producesScoreRows("off")).toBe(false);
    expect(producesScoreRows("shadow")).toBe(true);
    expect(producesScoreRows("dual_write")).toBe(true);
  });
});

describe("startup log", () => {
  beforeEach(() => {
    resetGradingEngineModeLogForTests();
  });

  test("logs the ceiling exactly once per process", async () => {
    process.env[ENV_KEY] = "shadow";
    const { logger } = await import("../../../utils/logger.js");
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    logGradingEngineModeOnce();
    logGradingEngineModeOnce();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ envCeiling: "shadow" });
  });

  test("flags an unrecognized env value so a typo is visible", async () => {
    process.env[ENV_KEY] = "dualwrite";
    const { logger } = await import("../../../utils/logger.js");
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    logGradingEngineModeOnce();
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      envCeiling: "off",
      unrecognizedEnvValue: true,
    });
  });
});
