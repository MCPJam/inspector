import { describe, expect, it } from "vitest";
import {
  MAX_CI_HEADER_BYTES,
  MAX_LAUNCHER_HEADER_BYTES,
  parseCiHeader,
  parseLauncherHeader,
} from "../launch-context";

/**
 * The declared half of run provenance, at the boundary that decides what a
 * caller is allowed to say about itself.
 *
 * Two rules do most of the work here, and they pull in opposite directions on
 * purpose:
 *
 *   * NOTHING OUTSIDE THE ALLOWLIST GETS THROUGH. The stamped origins are what
 *     make `source` audit truth; a caller that could declare `ui` would put a
 *     claim with no proof behind it into the same column as five proven ones.
 *   * NOTHING HERE MAY FAIL A LAUNCH. This is a display label. Refusing a run
 *     because its badge was malformed would trade a real capability for a
 *     cosmetic one.
 */

describe("parseLauncherHeader", () => {
  it("accepts the three declarable kinds", () => {
    for (const kind of ["cli", "mcp", "github_action"]) {
      expect(parseLauncherHeader(JSON.stringify({ kind }))).toEqual({ kind });
    }
  });

  it("keeps the client and version labels", () => {
    expect(
      parseLauncherHeader(
        JSON.stringify({
          kind: "cli",
          client: "mcpjam-cli",
          version: "8.2.0",
        }),
      ),
    ).toEqual({ kind: "cli", client: "mcpjam-cli", version: "8.2.0" });
  });

  it("drops a kind that restates a server-stamped origin", () => {
    for (const kind of ["ui", "api", "sdk", "schedule", "github_check"]) {
      expect(parseLauncherHeader(JSON.stringify({ kind }))).toBeUndefined();
    }
  });

  it("drops unknown keys rather than carrying them to the row", () => {
    expect(
      parseLauncherHeader(
        JSON.stringify({ kind: "mcp", client: "agent", surface: "workspace" }),
      ),
    ).toEqual({ kind: "mcp", client: "agent" });
  });

  it("survives everything a malformed header can be", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "   ",
      "{not json",
      "[]",
      '"a string"',
      "42",
      JSON.stringify({}),
      JSON.stringify({ kind: 7 }),
    ]) {
      expect(parseLauncherHeader(raw)).toBeUndefined();
    }
  });

  it("caps a client label", () => {
    const parsed = parseLauncherHeader(
      JSON.stringify({ kind: "mcp", client: "x".repeat(400) }),
    );
    // The MCP path fills `client` from an inbound user-agent — caller-controlled
    // text landing in a run-list cell.
    expect(parsed?.client).toHaveLength(200);
  });

  it("drops a header over the size cap whole", () => {
    const oversized = JSON.stringify({
      kind: "cli",
      client: "x".repeat(MAX_LAUNCHER_HEADER_BYTES),
    });
    expect(parseLauncherHeader(oversized)).toBeUndefined();
  });
});

describe("parseCiHeader", () => {
  it("maps GitHub's spelling onto the run row's", () => {
    expect(
      parseCiHeader(
        JSON.stringify({
          provider: "github_actions",
          runId: "1234.1",
          job: "evals",
          branch: "main",
          commitSha: "a1b2c3",
          runUrl: "https://github.test/run/1234",
        }),
      ),
    ).toEqual({
      provider: "github_actions",
      pipelineId: "1234.1",
      jobId: "evals",
      branch: "main",
      commitSha: "a1b2c3",
      runUrl: "https://github.test/run/1234",
    });
  });

  it("accepts the run row's own spelling too", () => {
    expect(
      parseCiHeader(JSON.stringify({ pipelineId: "p1", jobId: "j1" })),
    ).toEqual({ pipelineId: "p1", jobId: "j1" });
  });

  it("prefers the run row's spelling when a caller sends both", () => {
    expect(
      parseCiHeader(
        JSON.stringify({ pipelineId: "explicit", runId: "derived" }),
      ),
    ).toEqual({ pipelineId: "explicit" });
  });

  it("drops fields the run row has no column for", () => {
    const parsed = parseCiHeader(
      JSON.stringify({
        provider: "github_actions",
        repository: "acme/widgets",
        pullRequestNumber: 12,
        workflow: "CI",
      }),
    );
    // Provenance that half-fits its schema is worse than provenance that fits.
    expect(parsed).toEqual({ provider: "github_actions" });
  });

  it("returns nothing for an envelope with nothing usable in it", () => {
    expect(parseCiHeader(JSON.stringify({ branch: "  " }))).toBeUndefined();
    expect(parseCiHeader("{not json")).toBeUndefined();
    expect(parseCiHeader(undefined)).toBeUndefined();
  });

  it("drops a header over the size cap whole", () => {
    const oversized = JSON.stringify({
      branch: "x".repeat(MAX_CI_HEADER_BYTES),
    });
    expect(parseCiHeader(oversized)).toBeUndefined();
  });
});
