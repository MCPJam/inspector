import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_CHECK_FIELD_CAP,
  findConformanceCheck,
} from "../conformance-check.js";
import { projectConformanceReports } from "../conformance-runs.js";

function suiteReport(suiteKind: string, ids: string[], status = "failed") {
  return {
    suiteKind,
    report: {
      groups: [
        {
          id: "core",
          cases: ids.map((id) => ({ id, title: id, status })),
        },
      ],
    },
  };
}

/** 51 failing checks across two suites: one more than a page holds. */
const REPORTS = [
  suiteReport(
    "protocol",
    Array.from({ length: 30 }, (_, i) => `p-${i}`),
  ),
  suiteReport(
    "tasks",
    Array.from({ length: 21 }, (_, i) => `t-${i}`),
  ),
];

describe("paging a run's failing checks", () => {
  it("covers every failure of a finished run once, in order, across pages", () => {
    const run = { id: "run_1", status: "completed" };
    const first = projectConformanceReports(run, REPORTS);
    expect(first.checks).toHaveLength(50);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = projectConformanceReports(run, REPORTS, first.nextCursor);
    expect(second.checks).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    const seen = [...first.checks, ...second.checks].map(
      (check) => `${check.suiteKind}/${check.id}`,
    );
    expect(new Set(seen).size).toBe(51);
    expect(seen.slice(0, 2)).toEqual(["protocol/p-0", "protocol/p-1"]);
    expect(seen.at(-1)).toBe("tasks/t-20");
  });

  it("serves a running run's first page with no cursor to a second", () => {
    const running = { id: "run_1", status: "running" };
    const page = projectConformanceReports(running, REPORTS);
    expect(page.checks).toHaveLength(50);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeUndefined();
  });

  it("refuses a cursor while the run is still running", () => {
    const finished = projectConformanceReports(
      { id: "run_1", status: "completed" },
      REPORTS,
    );
    expect(() =>
      projectConformanceReports(
        { id: "run_1", status: "running" },
        REPORTS,
        finished.nextCursor,
      ),
    ).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("refuses a cursor issued for another run, or not issued at all", () => {
    const other = projectConformanceReports(
      { id: "run_2", status: "completed" },
      REPORTS,
    );
    for (const cursor of [other.nextCursor, "not-a-cursor"]) {
      expect(() =>
        projectConformanceReports(
          { id: "run_1", status: "completed" },
          REPORTS,
          cursor,
        ),
      ).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe("findConformanceCheck", () => {
  const detailed = {
    suiteKind: "protocol",
    report: {
      groups: [
        {
          id: "core",
          cases: [
            {
              id: "wire-schema-valid",
              title: "Wire Schema Valid",
              category: "wire",
              status: "failed",
              durationMs: 12,
              description: "Every message matches the schema.",
              error: "tools/call result is malformed",
              details: { blob: "x".repeat(CONFORMANCE_CHECK_FIELD_CAP + 10) },
              output: "y".repeat(CONFORMANCE_CHECK_FIELD_CAP + 10),
            },
            { id: "ping", title: "Ping", status: "passed", durationMs: 1 },
          ],
        },
      ],
    },
  };

  it("returns one check in full, with long details and output cut at the cap", () => {
    const check = findConformanceCheck(
      "run_1",
      [detailed],
      "wire-schema-valid",
      undefined,
    );
    expect(check).toMatchObject({
      runId: "run_1",
      suiteKind: "protocol",
      id: "wire-schema-valid",
      title: "Wire Schema Valid",
      status: "failed",
      durationMs: 12,
      error: "tools/call result is malformed",
      truncated: { details: true, output: true },
    });
    expect(String(check.details)).toHaveLength(CONFORMANCE_CHECK_FIELD_CAP);
    expect(check.output).toHaveLength(CONFORMANCE_CHECK_FIELD_CAP);
  });

  it("caps multibyte output in UTF-8 bytes, on a character boundary", () => {
    const emoji = {
      suiteKind: "protocol",
      report: {
        groups: [
          {
            id: "core",
            cases: [
              {
                id: "emoji",
                title: "Emoji",
                status: "failed",
                // The leading "a" puts the cap in the middle of an emoji.
                output: "a" + "😀".repeat(CONFORMANCE_CHECK_FIELD_CAP),
              },
            ],
          },
        ],
      },
    };
    const check = findConformanceCheck("run_1", [emoji], "emoji", undefined);
    const output = check.output!;
    expect(check.truncated.output).toBe(true);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(
      CONFORMANCE_CHECK_FIELD_CAP,
    );
    expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(
      CONFORMANCE_CHECK_FIELD_CAP - 4,
    );
    expect(output.endsWith("😀")).toBe(true);
    expect(output).not.toContain("\uFFFD");
  });

  it("keeps small details as stored", () => {
    const check = findConformanceCheck("run_1", [detailed], "ping", undefined);
    expect(check).toMatchObject({ status: "passed", pending: false });
    expect(check.truncated).toEqual({ details: false, output: false });
    expect(check).not.toHaveProperty("details");
  });

  it("says when a run has no such check", () => {
    expect(() =>
      findConformanceCheck("run_1", [detailed], "nope", undefined),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("asks for the suite when an id is in two, and resolves with it", () => {
    const twice = [detailed, suiteReport("tasks", ["wire-schema-valid"])];
    expect(() =>
      findConformanceCheck("run_1", twice, "wire-schema-valid", undefined),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(
      findConformanceCheck("run_1", twice, "wire-schema-valid", "tasks"),
    ).toMatchObject({ suiteKind: "tasks", status: "failed" });
  });
});
