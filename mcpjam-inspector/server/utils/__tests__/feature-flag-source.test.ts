import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
  loadFeatureFlagFileAtBoot,
  resolveFeatureFlagSource,
  rolloutAnswerWithoutPostHog,
} from "../feature-flag-source.js";

let dir: string;
let fileCount = 0;

/** A fresh path per file: the source reads a path once per process. */
function flagFile(contents: string): string {
  const path = join(dir, `flags-${(fileCount += 1)}.json`);
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flag-source-"));
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveFeatureFlagSource", () => {
  it("asks PostHog when neither the opt-out nor a file is set", () => {
    expect(resolveFeatureFlagSource()).toEqual({ kind: "posthog" });
  });

  it.each(["1", "true"])("turns every flag off under DO_NOT_TRACK=%s", (value) => {
    vi.stubEnv("DO_NOT_TRACK", value);
    expect(resolveFeatureFlagSource()).toEqual({ kind: "off" });
    expect(rolloutAnswerWithoutPostHog("local-browser-enabled")).toBe(false);
  });

  it("does not treat other DO_NOT_TRACK values as the opt-out", () => {
    vi.stubEnv("DO_NOT_TRACK", "0");
    expect(resolveFeatureFlagSource()).toEqual({ kind: "posthog" });
    expect(rolloutAnswerWithoutPostHog("local-browser-enabled")).toBeUndefined();
  });

  it("answers from the file instead of PostHog, with or without the opt-out", () => {
    const path = flagFile(
      JSON.stringify({ "evaluate-enabled": true, "copy-test": "treatment" }),
    );
    vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", path);
    expect(resolveFeatureFlagSource()).toEqual({
      kind: "file",
      answers: { "evaluate-enabled": true, "copy-test": "treatment" },
    });
    vi.stubEnv("DO_NOT_TRACK", "1");
    expect(resolveFeatureFlagSource()).toEqual({
      kind: "file",
      answers: { "evaluate-enabled": true, "copy-test": "treatment" },
    });
  });

  it("turns a rollout on only for true, and off for anything the file leaves out", () => {
    vi.stubEnv(
      "MCPJAM_FEATURE_FLAGS_FILE",
      flagFile(
        JSON.stringify({ on: true, off: false, variant: "true", other: "x" }),
      ),
    );
    expect(rolloutAnswerWithoutPostHog("on")).toBe(true);
    expect(rolloutAnswerWithoutPostHog("off")).toBe(false);
    expect(rolloutAnswerWithoutPostHog("variant")).toBe(false);
    expect(rolloutAnswerWithoutPostHog("missing")).toBe(false);
  });

  it("reads a path once, so a request does not touch the disk", () => {
    const path = flagFile(JSON.stringify({ a: true }));
    vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", path);
    expect(resolveFeatureFlagSource()).toMatchObject({ answers: { a: true } });
    writeFileSync(path, JSON.stringify({ a: false }));
    expect(resolveFeatureFlagSource()).toMatchObject({ answers: { a: true } });
  });
});

describe("a broken flag file", () => {
  it.each([
    ["is missing", null],
    ["is not JSON", "{ evaluate-enabled: true"],
    ["is an array", "[true]"],
    ["is a bare value", "true"],
    ["is null", "null"],
  ])("answers every flag off, never PostHog, when it %s", (_case, contents) => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const path =
      contents === null ? join(dir, "absent.json") : flagFile(contents);
    vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", path);

    expect(resolveFeatureFlagSource()).toEqual({ kind: "file", answers: {} });
    expect(rolloutAnswerWithoutPostHog("evaluate-enabled")).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/every feature flag is off/);
  });

  it("drops only the entries whose answer is not a boolean or a variant name", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.stubEnv(
      "MCPJAM_FEATURE_FLAGS_FILE",
      flagFile(
        JSON.stringify({
          kept: true,
          variant: "treatment",
          number: 1,
          empty: "",
          nested: { on: true },
          missing: null,
        }),
      ),
    );

    expect(resolveFeatureFlagSource()).toEqual({
      kind: "file",
      answers: { kept: true, variant: "treatment" },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain(
      '"number", "empty", "nested", "missing"',
    );
  });

  it("names the read error's code, not its message", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const path = join(dir, "absent.json");
    vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", path);

    resolveFeatureFlagSource();
    expect(error).toHaveBeenCalledWith(
      "[flags] MCPJAM_FEATURE_FLAGS_FILE could not be read (ENOENT), so every feature flag is off. Fix the file and restart.",
    );
  });

  it("never quotes the file when it is not JSON", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.stubEnv(
      "MCPJAM_FEATURE_FLAGS_FILE",
      flagFile("OPENAI_API_KEY=sk-test-123\n"),
    );

    resolveFeatureFlagSource();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      "[flags] MCPJAM_FEATURE_FLAGS_FILE is not valid JSON, so every feature flag is off. Fix the file and restart.",
    ]);
  });

  it("keeps a __proto__ key a flag name rather than a prototype", () => {
    vi.stubEnv(
      "MCPJAM_FEATURE_FLAGS_FILE",
      flagFile('{"__proto__": true, "constructor": "x"}'),
    );
    const source = resolveFeatureFlagSource();
    expect(source.kind === "file" && Object.keys(source.answers)).toEqual([
      "__proto__",
      "constructor",
    ]);
    expect(rolloutAnswerWithoutPostHog("toString")).toBe(false);
  });
});

describe("loadFeatureFlagFileAtBoot", () => {
  it("prints a broken file's problems on stderr once, at boot", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", flagFile("{ not json"));

    loadFeatureFlagFileAtBoot();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      "[flags] MCPJAM_FEATURE_FLAGS_FILE is not valid JSON, so every feature flag is off. Fix the file and restart.\n",
    );

    // The first evaluation reuses the boot read: no second report.
    expect(resolveFeatureFlagSource()).toEqual({ kind: "file", answers: {} });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("answers from the file it read at boot", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const path = flagFile(JSON.stringify({ "evaluate-enabled": true }));
    vi.stubEnv("MCPJAM_FEATURE_FLAGS_FILE", path);

    loadFeatureFlagFileAtBoot();
    writeFileSync(path, JSON.stringify({ "evaluate-enabled": false }));
    expect(rolloutAnswerWithoutPostHog("evaluate-enabled")).toBe(true);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("does nothing when no file is named", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    loadFeatureFlagFileAtBoot();
    expect(stderr).not.toHaveBeenCalled();
    expect(resolveFeatureFlagSource()).toEqual({ kind: "posthog" });
  });
});
