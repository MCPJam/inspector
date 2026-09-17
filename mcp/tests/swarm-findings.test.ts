import { expect, it } from "vitest";
import { swarmJourneyFindingsSchema } from "../../sdk/src/contract/swarm-finding.js";
import wire from "../../sdk/tests/fixtures/swarm-findings-wire.json";
import { compactJourneyFindings } from "../src/tools/platformTools.js";
it("prioritizes verified findings, bounds evidence, and preserves population", () => {
  const value = swarmJourneyFindingsSchema.parse(wire);
  const report = value.findings.find((row) => row.basis === "sessionReport")!;
  value.findings = [
    ...Array.from({ length: 10 }, (_, i) => ({
      ...report,
      id: `report:${i}`,
      citations: ["s/m:0", "s/m:1", "s/m:2"],
      reportExcerpt: {
        actual: "A long report. ".repeat(80),
        citations: ["s/m:0", "s/m:1", "s/m:2"],
      },
    })),
    ...value.findings.filter((row) => row.basis === "verifiedMechanism"),
  ];
  const result = compactJourneyFindings(value);
  expect(result.value.findings).toHaveLength(8);
  expect(result.value.findings[0].basis).toBe("verifiedMechanism");
  expect(result.value.population).toEqual(value.population);
  expect(result.value.personas).toEqual(value.personas);
  expect(result.omittedFindings).toBe(3);
  expect(result.omittedEvidence).toBeGreaterThan(0);
  expect(result.contractTruncated).toBe(true);
  expect(
    result.value.findings[1].reportExcerpt!.actual.length,
  ).toBeLessThanOrEqual(400);
  expect(value.findings[0].reportExcerpt!.actual.length).toBeGreaterThan(400);
});
