/** OpenAPI components are generated from the shared wire contract. */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { swarmSessionVerdictSchema } from "../src/contract/swarm-session-verdict.js";
import {
  swarmReportSchema,
  journeyRunVerdictSummarySchema,
} from "../src/contract/swarm-report.js";
import {
  EVAL_VERDICT_DECISION_REASONS,
  evalVerdictDecisionSchema,
} from "../src/contract/verdict-policy.js";
import { EVAL_VERDICT_DECISION_REASON_LABELS } from "../src/contract/decision-labels.js";
const path = new URL("../../docs/reference/openapi.json", import.meta.url);
const original = readFileSync(path, "utf8");
const document = JSON.parse(original);
for (const [name, schema] of Object.entries({
  SwarmSessionVerdict: swarmSessionVerdictSchema,
  JourneyRunVerdictSummary: journeyRunVerdictSummarySchema,
  SwarmReport: swarmReportSchema,
  EvalVerdictDecision: evalVerdictDecisionSchema,
})) {
  const { $schema: _schema, ...component } = z.toJSONSchema(schema, {
    target: "openapi-3.0",
  });
  document.components.schemas[name] = component;
}
const schemas = document.components.schemas;
schemas.JourneyRun.properties.verdictSummary = {
  $ref: "#/components/schemas/JourneyRunVerdictSummary",
};
schemas.JourneyRun.properties.report = {
  $ref: "#/components/schemas/SwarmReport",
};
schemas.JourneyRunSession.properties.verdict = {
  $ref: "#/components/schemas/SwarmSessionVerdict",
};
schemas.JourneyRunSession.properties.outcome.description =
  "Attempt execution lifecycle. Read verdict for the graded goal result.";

// Closed vocabularies spelled out in a GENERATED schema still have to be
// defined where an integrator reads them — that is what the decision-vocabulary
// ratchet in `mcpjam-inspector/server/routes/v1/__tests__` asserts, and these
// three sites are generated, so a description hand-written into the spec is
// erased by the next run of this script.
//
// The words are not new. The reasons carry `decision-labels.ts`'s own, which is
// what the CLI, the web app, Slack and the HTML report all print; the stage
// copies the description already on `StageResultRow.stage`, which is the same
// vocabulary. A spec that says it differently is a second reading of one run.
const verdictReasonDescription =
  "Why this verdict is what it is. Phrased as statements of what was " +
  "measured, never as blame. " +
  EVAL_VERDICT_DECISION_REASONS.map(
    (reason) =>
      `\`${reason}\` — ${EVAL_VERDICT_DECISION_REASON_LABELS[reason]}.`
  ).join(" ");
// The run-level list and the per-case one are the same vocabulary answering
// different questions, and the ratchet registers them separately.
schemas.EvalVerdictDecision.properties.reasons.items.description =
  verdictReasonDescription;
schemas.EvalVerdictDecision.properties.cases.items.properties.reason.description =
  verdictReasonDescription;
schemas.SwarmReport.properties.observations.items.properties.stage.description =
  schemas.StageResultRow.properties.stage.description;
schemas.JourneyRunSession.properties.criteria = {
  type: "object",
  required: ["status", "generation"],
  properties: {
    status: { type: "string", enum: ["pending", "completed", "failed"] },
    generation: { type: "number" },
    criterionIds: { type: "array", items: { type: "string" } },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["criterionId", "passed"],
        properties: {
          criterionId: { type: "string" },
          passed: { type: "boolean" },
          status: { type: "string", enum: ["scored", "error"] },
        },
      },
    },
  },
};
schemas.JourneyRunSession.properties.observations = {
  type: "array",
  items: {
    type: "object",
    required: ["evaluatorId", "predicateType", "role", "status"],
    properties: {
      evaluatorId: { type: "string" },
      predicateType: { type: "string" },
      role: { type: "string", enum: ["required", "advisory"] },
      status: {
        type: "string",
        enum: ["passed", "failed", "pending", "unavailable"],
      },
    },
  },
};
schemas.SwarmReport.properties.decision = {
  $ref: "#/components/schemas/EvalVerdictDecision",
};
for (const option of schemas.JourneyRunVerdictSummary.anyOf ??
  schemas.JourneyRunVerdictSummary.oneOf ??
  []) {
  if (option.properties?.decision)
    option.properties.decision = {
      $ref: "#/components/schemas/EvalVerdictDecision",
    };
}
// Preserve unrelated hand-authored OpenAPI formatting.
function endObject(text: string, start: number): number {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  throw new Error("Unclosed schema object");
}
let output = original;
for (const name of [
  "JourneyRun",
  "JourneyRunSession",
  "SwarmSessionVerdict",
  "JourneyRunVerdictSummary",
  "SwarmReport",
  "EvalVerdictDecision",
]) {
  const marker = `      "${name}": `;
  const at = output.indexOf(marker);
  const value = JSON.stringify(schemas[name], null, 2).replace(
    /\n/g,
    "\n      "
  );
  if (at >= 0) {
    const start = at + marker.length;
    output =
      output.slice(0, start) + value + output.slice(endObject(output, start));
  } else {
    const start = output.indexOf('"schemas": {') + '"schemas": '.length;
    const end = endObject(output, start) - 1;
    const prefix = output.slice(0, end).trimEnd();
    output = prefix + ",\n" + marker + value + "\n    " + output.slice(end);
  }
}
if (process.argv.includes("--check")) {
  if (output !== readFileSync(path, "utf8"))
    throw new Error(
      "Swarm reporting OpenAPI drift; run sdk/scripts/generate-swarm-report-schema.ts"
    );
} else writeFileSync(path, output);
