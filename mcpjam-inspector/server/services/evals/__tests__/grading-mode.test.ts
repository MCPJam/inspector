import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  isDualWrite,
  logGradingEngineModeOnce,
  parseGradingEngineMode,
  producesScoreRows,
  resetGradingEngineModeLogForTests,
  resolveFrozenRunGradingMode,
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

// =============================================================================
// B3b review follow-up: an ABSENT frozen stamp is a DECISION, not a missing
// opinion.
//
// `resolveGradingEngineMode` treats a position with no opinion as
// unconstrained and falls through to the env ceiling. That is right for an org
// flag nobody resolved and exactly wrong for a run snapshot: the backend writes
// no `gradingEngine` key when it resolved `off` (so an `off` run's snapshot
// stays byte-identical to a pre-B3b one), and the suite ceiling, the org flag
// and the legacy v2 clamp all live upstream of that stamp.
//
// Passing the absence through promotes every `off` run to whatever the process
// env says the moment an operator raises it — the inverse of the safety the
// ceilings exist for.
// =============================================================================
describe("resolveFrozenRunGradingMode", () => {
  beforeEach(() => {
    // The hazard only bites once an operator has raised the process ceiling.
    process.env[ENV_KEY] = "enforce";
  });

  test("an absent stamp is off, however high the env ceiling is", () => {
    expect(resolveFrozenRunGradingMode(undefined)).toBe("off");
  });

  test("the hazard it exists to close", () => {
    // The raw resolver, handed the same absence: promoted to the env ceiling.
    // Kept as a test so the difference between the two entry points stays
    // visible rather than looking like a redundant wrapper.
    expect(resolveGradingEngineMode({ runSnapshot: undefined })).toBe(
      "enforce"
    );
    expect(resolveFrozenRunGradingMode(undefined)).toBe("off");
  });

  test("a stamped position is honoured", () => {
    expect(resolveFrozenRunGradingMode({ mode: "shadow" })).toBe("shadow");
    expect(resolveFrozenRunGradingMode({ mode: "enforce" })).toBe("enforce");
  });

  test("the env ceiling still LOWERS a stamped position", () => {
    // The run snapshot is the backend's decision; this process's env var is a
    // second kill switch that can only ever take a position away.
    process.env[ENV_KEY] = "dual_write";
    expect(resolveFrozenRunGradingMode({ mode: "enforce" })).toBe("dual_write");
  });
});
