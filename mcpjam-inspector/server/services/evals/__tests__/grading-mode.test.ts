import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GRADING_ENGINE_MODES,
  isDualWrite,
  isEnforcing,
  parseGradingEngineMode,
  producesScoreRows,
  QUICK_RUN_GRADING_MODE,
  resolveFrozenRunGradingMode,
} from "../grading-mode.js";

// =============================================================================
// A run's mode is the position the backend froze onto it, read the same way
// everywhere. The cases below pin that reading: an absent or unreadable stamp
// is `off`, a readable one is honoured as stamped, and nothing in this
// process's environment moves it.
// =============================================================================

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseGradingEngineMode", () => {
  test("recognizes exactly the four positions", () => {
    expect(parseGradingEngineMode("off")).toBe("off");
    expect(parseGradingEngineMode("shadow")).toBe("shadow");
    expect(parseGradingEngineMode("dual_write")).toBe("dual_write");
    expect(parseGradingEngineMode("enforce")).toBe("enforce");
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

describe("resolveFrozenRunGradingMode", () => {
  test("an absent stamp is off", () => {
    expect(resolveFrozenRunGradingMode(undefined)).toBe("off");
    expect(resolveFrozenRunGradingMode(null)).toBe("off");
  });

  test("a stamp this build cannot read is off, not a pass-through", () => {
    // `{}` and a mode a NEWER backend added are decisions this build cannot
    // spell. The safe reading of those is the lowest position.
    for (const stamp of [
      {},
      { mode: "" },
      { mode: "DUAL_WRITE" },
      { mode: "turbo" },
      { mode: 3 },
    ]) {
      expect(resolveFrozenRunGradingMode(stamp)).toBe("off");
    }
  });

  test("a stamped position is honoured at every position", () => {
    for (const mode of GRADING_ENGINE_MODES) {
      expect(resolveFrozenRunGradingMode({ mode })).toBe(mode);
    }
  });

  test("the process environment cannot lower a stamped position", () => {
    // `MCPJAM_GRADING_ENGINE_MODE` used to cap every run at its value and read
    // unset as `off`. The backend accepts a Required judge only on a run frozen
    // at `enforce`, so a cap here would leave that gate accepted but not applied.
    for (const value of ["off", "shadow", "dual_write", "", "unrecognized"]) {
      vi.stubEnv("MCPJAM_GRADING_ENGINE_MODE", value);
      expect(resolveFrozenRunGradingMode({ mode: "enforce" })).toBe("enforce");
    }
  });

  test("the process environment cannot raise an absent stamp", () => {
    vi.stubEnv("MCPJAM_GRADING_ENGINE_MODE", "enforce");
    expect(resolveFrozenRunGradingMode(undefined)).toBe("off");
  });
});

describe("QUICK_RUN_GRADING_MODE", () => {
  test("writes real score rows, which the off of an absent stamp would not", () => {
    expect(QUICK_RUN_GRADING_MODE).toBe("enforce");
    expect(isDualWrite(QUICK_RUN_GRADING_MODE)).toBe(true);
  });
});

describe("mode predicates", () => {
  test("enforce and dual_write write real rows; only off writes none", () => {
    expect(isDualWrite("enforce")).toBe(true);
    expect(isDualWrite("dual_write")).toBe(true);
    expect(isDualWrite("shadow")).toBe(false);
    expect(isDualWrite("off")).toBe(false);
    expect(producesScoreRows("off")).toBe(false);
    expect(producesScoreRows("shadow")).toBe(true);
    expect(producesScoreRows("dual_write")).toBe(true);
    expect(producesScoreRows("enforce")).toBe(true);
  });

  test("only enforce makes the rows authoritative", () => {
    expect(isEnforcing("enforce")).toBe(true);
    expect(isEnforcing("dual_write")).toBe(false);
    expect(isEnforcing("shadow")).toBe(false);
    expect(isEnforcing("off")).toBe(false);
  });
});
