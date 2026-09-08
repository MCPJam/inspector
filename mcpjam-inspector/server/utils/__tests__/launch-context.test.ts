import { describe, expect, it } from "vitest";
import {
  MAX_CI_HEADER_BYTES,
  MAX_LAUNCHER_HEADER_BYTES,
  parseCiHeader,
  parseLauncherHeader,
} from "../launch-context";

/**
 * The launch-context headers are a LENIENT reader in front of a strict backend.
 *
 * That is the whole design, and it is what these tests are about. Both `/v1`
 * eval-run bodies are `.strict()`, so the label had to travel as a header to
 * survive a deployment that predates it; and by the same argument every
 * malformed, oversized or unrecognized value has to be DROPPED rather than
 * refused. A cosmetic badge that can fail a launch is worse than no badge.
 *
 * The other half is what it must never do: launder a claim about a
 * server-stamped origin into the run row.
 */

describe("the declared launcher", () => {
  it("reads a well-formed label", () => {
    expect(
      parseLauncherHeader(
        '{"kind":"github_action","client":"mcpjam-cli","version":"8.1.0"}',
      ),
    ).toEqual({
      kind: "github_action",
      client: "mcpjam-cli",
      version: "8.1.0",
    });
  });

  it("keeps a bare kind and invents no display strings", () => {
    expect(parseLauncherHeader('{"kind":"cli"}')).toEqual({ kind: "cli" });
  });

  it.each(["api", "sdk", "ui", "schedule", "benchmark", "", "CLI"])(
    "drops the server-stamped or unknown kind %j rather than storing it",
    (kind) => {
      // These are the values the server already knows for itself. Accepting a
      // claim about one would be the single way to forge the audit field, so
      // the label is dropped — and the run still launches under its real
      // `source`, which is the point of dropping rather than refusing.
      expect(parseLauncherHeader(JSON.stringify({ kind }))).toBeUndefined();
    },
  );

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", '["cli"]'],
    ["a JSON scalar", '"cli"'],
    ["an empty header", ""],
    ["no header at all", undefined],
  ])("drops %s", (_label, raw) => {
    expect(parseLauncherHeader(raw as string | undefined)).toBeUndefined();
  });

  it("drops an oversized header without parsing it", () => {
    const oversized = JSON.stringify({
      kind: "cli",
      client: "x".repeat(MAX_LAUNCHER_HEADER_BYTES),
    });
    expect(parseLauncherHeader(oversized)).toBeUndefined();
  });

  it("measures the size cap in BYTES, not characters", () => {
    // A multi-byte payload that measures short in characters is not short: the
    // cap is about what we agreed to read off the wire.
    const multibyte = JSON.stringify({
      kind: "cli",
      client: "é".repeat(MAX_LAUNCHER_HEADER_BYTES - 30),
    });
    expect(multibyte.length).toBeLessThan(MAX_LAUNCHER_HEADER_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(
      MAX_LAUNCHER_HEADER_BYTES,
    );
    expect(parseLauncherHeader(multibyte)).toBeUndefined();
  });

  it("truncates a long display string instead of dropping the label", () => {
    const parsed = parseLauncherHeader(
      JSON.stringify({ kind: "mcp", client: "a".repeat(300) }),
    );
    // The kind is the useful part; a client name that is too long is a bad
    // table cell, not a reason to lose the origin.
    expect(parsed?.kind).toBe("mcp");
    expect(parsed?.client?.length).toBe(128);
  });

  it("drops unknown keys rather than forwarding them to a closed validator", () => {
    const parsed = parseLauncherHeader(
      '{"kind":"cli","surface":"workspace","apiKeyId":"key_live_1"}',
    );
    // `startTestSuiteRun`'s validator is an exact object, so a forwarded extra
    // key would turn a cosmetic label into a failed launch — and `surface` in
    // particular is the VERIFIED field, which no caller may set.
    expect(parsed).toEqual({ kind: "cli" });
  });
});

describe("the CI envelope", () => {
  it("maps the SDK's GitHub vocabulary onto the run's field names", () => {
    // `detectCiMetadata` speaks GitHub (`runId`, `job`); the run row speaks
    // provider-neutral (`pipelineId`, `jobId`). Translating here, once, is what
    // keeps a GitLab client from having to pretend to be GitHub.
    expect(
      parseCiHeader(
        JSON.stringify({
          provider: "github_actions",
          runId: "1234.2",
          job: "evals",
          runUrl: "https://github.com/o/r/actions/runs/1234",
          branch: "main",
          commitSha: "a".repeat(40),
          repository: "o/r",
          workflow: "CI",
          pullRequestNumber: 7,
        }),
      ),
    ).toEqual({
      provider: "github_actions",
      pipelineId: "1234.2",
      jobId: "evals",
      runUrl: "https://github.com/o/r/actions/runs/1234",
      branch: "main",
      commitSha: "a".repeat(40),
    });
  });

  it("prefers a client that already speaks the run shape", () => {
    expect(
      parseCiHeader('{"pipelineId":"p_1","runId":"ignored","jobId":"j_1"}'),
    ).toEqual({ pipelineId: "p_1", jobId: "j_1" });
  });

  it("stores nothing when no field survives, rather than an empty envelope", () => {
    // `{}` would read back as "we recorded CI metadata for this run", which is
    // a different claim from "this run was not in CI".
    expect(
      parseCiHeader('{"repository":"o/r","workflow":"CI"}'),
    ).toBeUndefined();
    expect(parseCiHeader("{}")).toBeUndefined();
  });

  it("drops an over-long CI field rather than storing a prefix of it", () => {
    // The fields are identifiers and URLs, and half of one is not a shorter
    // version of it: a truncated sha matches no baseline, and a truncated
    // runUrl is a dead link that still looks like a live one. Absent is the
    // honest answer, and it is the one a reader can see.
    const parsed = parseCiHeader(
      JSON.stringify({
        provider: "github_actions",
        commitSha: "a".repeat(600),
        runUrl: `https://github.com/o/r/actions/runs/${"9".repeat(600)}`,
        branch: "main",
      }),
    );
    expect(parsed).toEqual({ provider: "github_actions", branch: "main" });

    // Exactly at the cap is still a value, not an over-long one.
    const atCap = parseCiHeader(JSON.stringify({ branch: "b".repeat(512) }));
    expect(atCap).toEqual({ branch: "b".repeat(512) });
    expect(
      parseCiHeader(JSON.stringify({ branch: "b".repeat(513) })),
    ).toBeUndefined();
  });

  it("drops an oversized or malformed envelope", () => {
    expect(
      parseCiHeader(
        JSON.stringify({ runUrl: "x".repeat(MAX_CI_HEADER_BYTES) }),
      ),
    ).toBeUndefined();
    expect(parseCiHeader("{oops")).toBeUndefined();
    expect(parseCiHeader(undefined)).toBeUndefined();
  });
});
