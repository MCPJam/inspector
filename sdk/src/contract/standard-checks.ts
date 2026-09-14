import { z } from "zod";
import type { Predicate } from "../predicates/types.js";
import { ASSERTION_STAGE } from "./evaluator-stage.js";
import type { UserValueStage } from "./chain.js";
import {
  STANDARD_CHECK_ASSERTION_KINDS,
  type StandardAssertionCheckId,
} from "./standard-check-ids.js";

export type StandardCheck =
  | {
      id: StandardAssertionCheckId;
      stage: UserValueStage;
      label: string;
      kind: "assertion";
      preset: Predicate;
    }
  | {
      id: string;
      stage: UserValueStage;
      label: string;
      kind: "runner";
      measuredBy: "connection" | "discovery";
    }
  | { id: string; stage: UserValueStage; label: string; kind: "judge" };

const presets: Record<
  StandardAssertionCheckId,
  { label: string; rule: Predicate }
> = {
  "discovery.description": {
    label: "Tool descriptions meet the minimum length",
    rule: { type: "toolDescriptionsPresent", minLength: 20 },
  },
  "discovery.annotations": {
    label: "Every tool declares annotations",
    rule: { type: "toolAnnotationsPresent" },
  },
  "discovery.collisions": {
    label: "Tool names are unique within each server",
    rule: { type: "toolNamesUnique" },
  },
  "discovery.deprecated": {
    label: "No tool description marks itself deprecated",
    rule: { type: "noDeprecatedToolExposed", role: "advisory" },
  },
  "call.schema": {
    label: "Input schemas have an object root and documented parameters",
    rule: { type: "toolInputSchemasWellFormed" },
  },
  "response.schema": {
    label: "Every tool declares an output schema",
    rule: { type: "toolOutputSchemasPresent" },
  },
  "selection.hops": {
    label: "Tool call count stays below the configured limit",
    rule: { type: "toolCallCountUnder", count: 4 },
  },
  "call.parameters": {
    label: "Arguments match the tool's input schema",
    rule: { type: "argumentsMatchToolSchema" },
  },
  "call.repeated": {
    label: "No identical call repeated back-to-back",
    rule: { type: "noRepeatedIdenticalCall", role: "advisory" },
  },
  "response.performance": {
    label: "Tool latency stays below the configured limit",
    rule: { type: "toolLatencyUnder", ms: 5000 },
  },
  "response.size": {
    label: "Tool result size stays below the configured limit",
    rule: { type: "toolResultSizeUnder", maxBytes: 64000 },
  },
  "response.errors": {
    label: "No tool returns an error",
    rule: { type: "noToolErrors" },
  },
  "response.recovery": {
    label: "Tool errors name an input",
    rule: { type: "toolErrorNamesInput", role: "advisory" },
  },
  "response.pagination": {
    label: "Full pages include a continuation marker",
    rule: { type: "fullPageHasContinuation", role: "advisory" },
  },
  "userValue.turns": {
    label: "User turn count stays below the configured limit",
    rule: { type: "turnCountUnder", turns: 6 },
  },
};

export const STANDARD_CHECKS: readonly StandardCheck[] = [
  {
    id: "connection.success",
    stage: "connection",
    label: "Connection",
    kind: "runner",
    measuredBy: "connection",
  },
  {
    id: "discovery.toolsList",
    stage: "discovery",
    label: "Tool discovery",
    kind: "runner",
    measuredBy: "discovery",
  },
  ...Object.entries(presets).map(([key, { label, rule }]): StandardCheck => {
    const id = key as StandardAssertionCheckId;
    return {
      id,
      label,
      kind: "assertion",
      stage: ASSERTION_STAGE[STANDARD_CHECK_ASSERTION_KINDS[id]],
      preset: { ...rule, role: "advisory", severity: "warn" },
    };
  }),
  {
    id: "userValue.outcome",
    stage: "userValue",
    label: "Outcome achieved",
    kind: "judge",
  },
];

/** Explicit [] clears suppression; omission preserves it at update boundaries. */
export const suppressedSuiteStandardCheckIdsSchema = z
  .array(
    z.enum(
      Object.keys(STANDARD_CHECK_ASSERTION_KINDS) as [
        StandardAssertionCheckId,
        ...StandardAssertionCheckId[],
      ]
    )
  )
  .max(64);
