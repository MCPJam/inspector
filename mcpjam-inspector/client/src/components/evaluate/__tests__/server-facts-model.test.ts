/**
 * The server-facts presentation rules (plan step F2).
 *
 * Every test here is about a CLAIM the UI must not make: that an unobserved
 * phase failed, that an estimate is a measurement, that a signal is a
 * violation, or that a related assessment describes this run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EvalRunServerFactsV1 } from "@mcpjam/sdk/contract";
// Read from disk rather than imported: the golden lives in the SDK package,
// and a deep relative `import` across the workspace boundary would put the
// client's build graph one refactor away from breaking on a file it does not
// own.
const golden = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../../sdk/tests/fixtures/server-facts-golden.json",
    ),
    "utf8",
  ),
) as unknown;
import {
  connectionLines,
  discoveryLines,
  formatApproxTokens,
  formatWindowShare,
  groupPrechecksByTool,
  payloadBasisNote,
  precheckQualifier,
  precheckTone,
  summarizeServerFacts,
  unavailableReasonCopy,
} from "../server-facts-model";

const documents = golden as unknown as Record<string, EvalRunServerFactsV1>;

describe("the one-line summary", () => {
  it("names the denominator a share is against", () => {
    // A bare percentage reads as a measurement of the model's actual context,
    // which nothing here knows.
    const summary = summarizeServerFacts(documents.ready!);
    expect(summary).toContain("57 tools");
    expect(summary).toMatch(/of a ~?200k window/);
  });

  it("says what is missing rather than reporting zeros", () => {
    expect(summarizeServerFacts(documents.snapshotMissing!)).toBe(
      "No tool snapshot was captured for this run",
    );
  });
});

describe("tokens read as estimates", () => {
  it("prefixes every token figure with ~", () => {
    expect(formatApproxTokens(19_800)).toBe("~19.8k");
    expect(formatApproxTokens(900)).toBe("~900");
    expect(formatApproxTokens(0)).toBe("~0");
  });

  it("carries the document's disclaimer onto the lines that use it", () => {
    const lines = discoveryLines(documents.ready!);
    const catalog = lines.find((line) => line.label === "Catalog size");
    expect(catalog?.note).toContain("not measured context consumption");
  });

  it("says which quantity a payload number is", () => {
    // The three payload sizes are different numbers. A reader who cannot tell
    // them apart will compare them and see a drop that never happened.
    expect(payloadBasisNote(documents.ready!.servers[0]!)).toContain(
      "as the client assembled it",
    );
    expect(payloadBasisNote(documents.partialCapture!.servers[0]!)).toContain(
      "as we retained it",
    );
    expect(payloadBasisNote(documents.partialCapture!.servers[0]!)).toContain(
      "incomplete",
    );
  });

  it("rounds a share to whole percents", () => {
    expect(formatWindowShare(0.099)).toBe("10%");
    expect(formatWindowShare(0)).toBe("0%");
  });
});

describe("an unobserved phase is not a failed one", () => {
  it("reads as 'not observed', in a neutral tone", () => {
    const lines = connectionLines(documents.setupNotObserved!);
    expect(lines[0]).toMatchObject({
      label: "Connection",
      value: "not observed",
      tone: "empty",
    });
  });

  it("marks a real failure, and says what it could NOT establish", () => {
    const lines = connectionLines(documents.partialCapture!);
    expect(lines[0]).toMatchObject({ value: "failed", tone: "attention" });
    const attribution = lines.find((line) => line.label === "Attributed to");
    expect(attribution?.value).toBe("the server");
    expect(attribution?.note).toContain("egress was verified");
  });

  it("says a connect duration is per RUN, not per trial", () => {
    // A run with 200 trials copies one connect onto all of them; a reader who
    // averages it gets a three-second connection measured 200 times.
    const duration = connectionLines(documents.ready!).find(
      (line) => line.label === "Connect time",
    );
    expect(duration?.note).toContain("once for the run");
  });
});

describe("a server that did not answer has no numbers", () => {
  it("reads as 'not captured', never as zero tools", () => {
    const lines = discoveryLines(documents.partialCapture!);
    const failed = lines.find((line) => line.value === "not captured");
    expect(failed?.note).toContain("absent, not zero");
    // …and the servers that DID answer are still listed.
    expect(lines.some((line) => line.value === "4 tools")).toBe(true);
  });
});

describe("prechecks are signals unless the class says otherwise", () => {
  const server = documents.ready!.servers[0]!;

  it("groups by tool, which is the unit somebody edits", () => {
    const groups = groupPrechecksByTool(server);
    expect(groups.map((group) => group.toolName).sort()).toEqual([
      "create_issue",
      "delete_issue",
      "list_issues",
    ]);
  });

  it("reserves the attention tone for spec violations", () => {
    const quality = server.prechecks.find(
      (row) => row.class === "quality_signal",
    )!;
    expect(precheckTone(quality)).toBe("set");
    expect(precheckQualifier(quality)).toBeNull();
  });

  it("reports a protocol-dependent rule as a question, not a defect", () => {
    // The rule may not apply to this server at all. Rendering it as a
    // violation would accuse a server that is correct under its own protocol
    // version.
    const dependent = server.prechecks.find((row) => row.protocolDependent)!;
    expect(precheckTone(dependent)).toBe("empty");
    expect(precheckQualifier(dependent)).toBe("depends on protocol version");
  });
});

describe("unavailable reasons explain themselves", () => {
  it("distinguishes the three, and none of them says 'failed'", () => {
    for (const [name, contains] of [
      ["snapshotMissing", "stored no tool snapshot"],
      ["partialCapture", "not zero, they are unmeasured"],
      ["setupNotObserved", "unmeasured — not failed"],
    ] as const) {
      expect(unavailableReasonCopy(documents[name]!)).toContain(contains);
    }
    expect(unavailableReasonCopy(documents.ready!)).toBeNull();
  });
});
