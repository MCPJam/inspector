import { expect, it } from "vitest";
import {
  swarmJourneyFindingsSchema,
  USER_VALUE_STAGES,
  SWARM_FINDING_DISPOSITION_LABELS,
} from "@mcpjam/sdk/contract";
import wire from "../../../../../../sdk/tests/fixtures/swarm-findings-wire.json";
import { deriveSwarmFindingsModelFromWire } from "../findings/findings-derivation";
import { JOURNEY_STAGE_COPY } from "../findings/journey-stages";
it("renders producer dispositions even when no legacy run scores exist", () => {
  const journeyFindings = swarmJourneyFindingsSchema.parse(wire);
  const model = deriveSwarmFindingsModelFromWire({
    journeyFindings,
    personas: [],
    runs: [],
  });
  expect(model.personas[0].sentiment.label).toBe(
    SWARM_FINDING_DISPOSITION_LABELS[journeyFindings.personas[0].disposition],
  );
  expect(model.personas[0].goals[0].sessions).toBe(1);
  expect(model.personas[0].goals[0].stages.connection.state).toBe("none");
  expect(model.personas[0].goals[0].stages.response.state).toBe("fail");
});
it("covers every canonical journey stage", () => {
  expect(Object.keys(JOURNEY_STAGE_COPY).sort()).toEqual(
    [...USER_VALUE_STAGES].sort(),
  );
});
