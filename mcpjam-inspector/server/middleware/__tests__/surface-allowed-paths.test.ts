import { describe, expect, it } from "vitest";
import {
  composeAllowedPaths,
  SLACK_ALLOWED_PATH_DELTAS,
  SURFACE_ALLOWED_PATHS_BASE,
  SURFACE_ALLOWED_PATH_DELTAS,
} from "../surface-allowed-paths.js";

/**
 * The allowlist is the ENTIRE control on a chat surface's service token.
 *
 * `slk_` and `dsc_` name the BOT, not a person — the acting user comes from
 * headers and the server mints a delegated token for them. That is what makes
 * a bot credential acceptable, and it holds only while the paths it can reach
 * are the ones the surface actually drives. Slack and Discord each kept their
 * own copy of the list, the copies had already diverged, and nothing said
 * whether the difference was deliberate.
 *
 * These tests do not demand the two lists be identical. They demand every
 * difference be a declared delta with a reason.
 */

const PROJECT = "/api/v1/projects/proj_1";

function matches(patterns: ReadonlyArray<RegExp>, path: string): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

describe("the shared base", () => {
  const slack = composeAllowedPaths(SLACK_ALLOWED_PATH_DELTAS);
  const surface = composeAllowedPaths(SURFACE_ALLOWED_PATH_DELTAS);

  it("is reachable by BOTH surfaces, entry for entry", () => {
    for (const pattern of SURFACE_ALLOWED_PATHS_BASE) {
      expect(slack, `slack lost a base entry: ${pattern}`).toContain(pattern);
      expect(surface, `discord lost a base entry: ${pattern}`).toContain(
        pattern
      );
    }
  });

  it("covers exactly the paths the surfaces drive", () => {
    for (const path of [
      `${PROJECT}/agent`,
      "/api/v1/projects",
      `${PROJECT}/proposed-actions/act_1/execute`,
      `${PROJECT}/eval-runs/run_1`,
      `${PROJECT}/eval-runs/run_1/iterations`,
      `${PROJECT}/eval-runs/run_1/iterations/it_1/steps`,
    ]) {
      expect(matches(SURFACE_ALLOWED_PATHS_BASE, path), path).toBe(true);
    }
  });

  it("does NOT reach the rest of /api/v1", () => {
    // Spot checks on the categories that would matter most if the anchoring
    // ever regressed: writes, credential import, and unrelated surfaces.
    for (const path of [
      `${PROJECT}/servers`,
      `${PROJECT}/servers/srv_1/oauth/import-tokens`,
      `${PROJECT}/eval-suites`,
      `${PROJECT}/environments`,
      `${PROJECT}/journeys`,
      `${PROJECT}/tunnels`,
      "/api/v1/me",
    ]) {
      expect(matches(SURFACE_ALLOWED_PATHS_BASE, path), path).toBe(false);
    }
  });

  it("anchors every pattern at BOTH ends", () => {
    // An unanchored pattern matches any longer path that has an allowed one as
    // a prefix — the classic way an allowlist quietly stops being one.
    for (const pattern of [
      ...SURFACE_ALLOWED_PATHS_BASE,
      ...SLACK_ALLOWED_PATH_DELTAS.map((delta) => delta.pattern),
      ...SURFACE_ALLOWED_PATH_DELTAS.map((delta) => delta.pattern),
    ]) {
      expect(
        pattern.source.startsWith("^"),
        `${pattern} must start with ^`
      ).toBe(true);
      expect(pattern.source.endsWith("$"), `${pattern} must end with $`).toBe(
        true
      );
    }
  });

  it("refuses a path that merely STARTS with an allowed one", () => {
    expect(
      matches(SURFACE_ALLOWED_PATHS_BASE, `${PROJECT}/agent/secrets`)
    ).toBe(false);
    expect(matches(SURFACE_ALLOWED_PATHS_BASE, "/api/v1/projects/x")).toBe(
      false
    );
  });
});

describe("declared deltas", () => {
  it("Slack's ONE extra is the retired Run-it shim, and it is a write", () => {
    // Pin the count the name promises. `[0]` below reads as if one delta were
    // guaranteed; a second added later would slip past every assertion here
    // while the title kept insisting there is only one.
    expect(SLACK_ALLOWED_PATH_DELTAS).toHaveLength(1);
    const slack = composeAllowedPaths(SLACK_ALLOWED_PATH_DELTAS);
    const surface = composeAllowedPaths(SURFACE_ALLOWED_PATH_DELTAS);
    const createRun = `${PROJECT}/eval-runs`;

    // Reachable from Slack, NOT from Discord — the divergence, made explicit.
    expect(matches(slack, createRun)).toBe(true);
    expect(matches(surface, createRun)).toBe(false);

    const reason = SLACK_ALLOWED_PATH_DELTAS[0]?.reason ?? "";
    // The reason has to say it is temporary and what unblocks its removal,
    // because a bot credential reaching a run-CREATING write is exactly what
    // the proposal/approval flow exists to prevent.
    expect(reason).toMatch(/retired/i);
    expect(reason).toMatch(/Phase 4/);
  });

  it("Discord's extra is the connect-link mint, which is not an /api/v1 route", () => {
    const surface = composeAllowedPaths(SURFACE_ALLOWED_PATH_DELTAS);
    expect(matches(surface, "/api/surface-link/session")).toBe(true);
    expect(
      matches(
        composeAllowedPaths(SLACK_ALLOWED_PATH_DELTAS),
        "/api/surface-link/session"
      )
    ).toBe(false);
  });

  it("every delta carries a substantive reason", () => {
    for (const delta of [
      ...SLACK_ALLOWED_PATH_DELTAS,
      ...SURFACE_ALLOWED_PATH_DELTAS,
    ]) {
      expect(
        delta.reason.length,
        `${delta.pattern} needs a real reason, not a placeholder`
      ).toBeGreaterThan(40);
    }
  });

  it("no delta duplicates a base entry", () => {
    // A delta that restates the base is a difference that is not a difference,
    // and it hides the real ones.
    const baseSources = new Set(
      SURFACE_ALLOWED_PATHS_BASE.map((pattern) => pattern.source)
    );
    for (const delta of [
      ...SLACK_ALLOWED_PATH_DELTAS,
      ...SURFACE_ALLOWED_PATH_DELTAS,
    ]) {
      expect(
        baseSources.has(delta.pattern.source),
        `${delta.pattern} is already in the base — remove the delta`
      ).toBe(false);
    }
  });
});
