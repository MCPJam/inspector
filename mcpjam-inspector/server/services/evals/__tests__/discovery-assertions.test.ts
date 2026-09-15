import { afterEach, expect, it } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  serveMultiPageFixtureOnPort,
  type ServedMultiPageFixture,
} from "../../../../../sdk/tests/support/multi-page-fixture.js";
import { collectToolDeclarations } from "../transcript-evidence";
import {
  buildEvalIterationVerdict,
  type EvalIterationVerdictInput,
} from "../iteration-verdict";
let manager: MCPClientManager | undefined;
let fixture: ServedMultiPageFixture | undefined;
afterEach(async () => {
  await manager?.disconnectAllServers();
  await fixture?.close();
});
function verdict(
  evidence: ReturnType<typeof collectToolDeclarations>,
  role: "gating" | "advisory" = "gating",
) {
  return buildEvalIterationVerdict({
    promptTurns: [],
    toolsCalledByPrompt: [],
    isNegativeTest: false,
    matchOptions: undefined,
    turnCheckResults: [],
    effectivePredicates: [{ type: "toolNamesUnique", role }],
    trace: undefined,
    usage: undefined,
    renderObservations: undefined,
    iterationError: undefined,
    failOnToolError: false,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
    ...evidence,
  } as EvalIterationVerdictInput);
}
it("preserves duplicate declarations through real paginated discovery, runner conversion and verdict", async () => {
  fixture = await serveMultiPageFixtureOnPort({ duplicateToolName: true, declareOutputSchema: true });
  manager = new MCPClientManager();
  await manager.connectToServer("fixture", {
    url: fixture.url,
    mcpProtocolVersion: "2026-07-28",
  });
  await manager.getToolsForAiSdk(["fixture"]);
  const evidence = collectToolDeclarations(manager, ["fixture"]);
  expect(evidence.declarationsCaptured).toBe("complete");
  expect(evidence.toolDeclarations).toHaveLength(12);
  expect(evidence.toolDeclarations?.[0].outputSchema).toEqual({ type: "object", properties: { value: { type: "string" } } });
  expect(evidence.toolDeclarations?.[1].outputSchema).toBeUndefined();
  expect(verdict(evidence).predicateResults[0]).toMatchObject({
    passed: false,
  });
  const advisory = verdict(evidence, "advisory");
  expect(advisory.predicateResults[0].passed).toBe(false);
  expect(advisory.passed).toBe(true);
  expect(
    verdict(collectToolDeclarations(manager, ["fixture", "missing"]))
      .predicateResults[0],
  ).toMatchObject({ status: "error" });
});
it("an older producer never fabricates complete evidence", () => {
  expect(
    verdict(collectToolDeclarations({}, ["fixture"])).predicateResults[0],
  ).toMatchObject({ status: "error" });
});
