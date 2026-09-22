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
      name: string;
      label: string;
      kind: "assertion";
      preset: Predicate;
    }
  | {
      id: string;
      stage: UserValueStage;
      name: string;
      label: string;
      kind: "runner";
      measuredBy: "connection" | "discovery";
    }
  | {
      id: string;
      stage: UserValueStage;
      name: string;
      label: string;
      kind: "judge";
    };

const presets: Record<
  StandardAssertionCheckId,
  { name: string; label: string; rule: Predicate }
> = {
  "discovery.description": {
    name: "Description quality",
    label: "Tool descriptions meet the minimum length",
    rule: { type: "toolDescriptionsPresent", minLength: 20 },
  },
  "discovery.annotations": {
    name: "Tool annotations",
    label: "Every tool declares annotations",
    rule: { type: "toolAnnotationsPresent" },
  },
  "discovery.collisions": {
    name: "Name collisions",
    label: "Tool names are unique within each server",
    rule: { type: "toolNamesUnique" },
  },
  "discovery.deprecated": {
    name: "Deprecated tools exposed",
    label: "No tool description marks itself deprecated",
    rule: { type: "noDeprecatedToolExposed", role: "advisory" },
  },
  "call.schema": {
    name: "Input schema quality",
    label: "Input schemas have an object root and documented parameters",
    rule: { type: "toolInputSchemasWellFormed" },
  },
  "response.schema": {
    name: "Output schema quality",
    label: "Every tool declares an output schema",
    rule: { type: "toolOutputSchemasPresent" },
  },
  "selection.hops": {
    name: "Tool hops before the right tool",
    label: "Tool call count stays below the configured limit",
    rule: { type: "toolCallCountUnder", count: 4 },
  },
  "call.parameters": {
    name: "Parameter validity",
    label: "Arguments match the tool's input schema",
    rule: { type: "argumentsMatchToolSchema" },
  },
  "call.repeated": {
    name: "Repeated identical calls",
    label: "No identical call repeated back-to-back",
    rule: { type: "noRepeatedIdenticalCall", role: "advisory" },
  },
  "response.performance": {
    name: "Tool latency",
    label: "Tool latency stays below the configured limit",
    rule: { type: "toolLatencyUnder", ms: 5000 },
  },
  "response.size": {
    name: "Payload size",
    label: "Tool result size stays below the configured limit",
    rule: { type: "toolResultSizeUnder", maxBytes: 64000 },
  },
  "response.errors": {
    name: "Tool errors (isError)",
    label: "No tool returns an error",
    rule: { type: "noToolErrors" },
  },
  "response.recovery": {
    name: "Error messages that help recovery",
    label: "Tool errors name an input",
    rule: { type: "toolErrorNamesInput", role: "advisory" },
  },
  "response.pagination": {
    name: "Pagination and truncation clarity",
    label: "Full pages include a continuation marker",
    rule: { type: "fullPageHasContinuation", role: "advisory" },
  },
  "userValue.turns": {
    name: "User turns to completion",
    label: "User turn count stays below the configured limit",
    rule: { type: "turnCountUnder", turns: 6 },
  },
};

export const STANDARD_CHECKS: readonly StandardCheck[] = [
  {
    id: "connection.success",
    name: "Successful connection",
    stage: "connection",
    label: "Connection",
    kind: "runner",
    measuredBy: "connection",
  },
  {
    id: "discovery.toolsList",
    name: "Tools listed",
    stage: "discovery",
    label: "Tool discovery",
    kind: "runner",
    measuredBy: "discovery",
  },
  ...Object.entries(presets).map(
    ([key, { name, label, rule }]): StandardCheck => {
      const id = key as StandardAssertionCheckId;
      return {
        id,
        name,
        label,
        kind: "assertion",
        stage: ASSERTION_STAGE[STANDARD_CHECK_ASSERTION_KINDS[id]],
        preset: { ...rule, role: "advisory", severity: "warn" },
      };
    }
  ),
  {
    id: "userValue.outcome",
    name: "Outcome achieved",
    stage: "userValue",
    label: "Outcome achieved",
    kind: "judge",
  },
];

/**
 * The predicate kinds a standard check implements.
 *
 * Every kind here has exactly one standard check, which is what makes the name
 * map below total and unambiguous; `standard-checks.test.ts` pins that.
 */
export type StandardCheckPredicateKind =
  (typeof STANDARD_CHECK_ASSERTION_KINDS)[StandardAssertionCheckId];

/**
 * The name a reader recognises a standard check by, keyed by the predicate kind
 * that implements it.
 *
 * A run page titles a row by WHAT it evaluates ("Tool errors (isError)"), and
 * shows the configured rule as the row's expectation underneath. The authoring
 * page uses the same title, because a scorer the reader met on a run and the
 * scorer they edit are the same object — the vocabulary split this module's
 * docblock exists to close.
 *
 * Derived from `presets` rather than restated beside it, so a renamed check
 * cannot leave a stale title behind.
 */
export const STANDARD_CHECK_NAME_BY_KIND: Readonly<
  Record<StandardCheckPredicateKind, string>
> = Object.fromEntries(
  (
    Object.entries(STANDARD_CHECK_ASSERTION_KINDS) as [
      StandardAssertionCheckId,
      StandardCheckPredicateKind
    ][]
  ).map(([id, kind]) => [kind, presets[id].name])
) as Record<StandardCheckPredicateKind, string>;

/** Explicit [] clears suppression; omission preserves it at update boundaries. */
export const suppressedSuiteStandardCheckIdsSchema = z
  .array(
    z.enum(
      Object.keys(STANDARD_CHECK_ASSERTION_KINDS) as [
        StandardAssertionCheckId,
        ...StandardAssertionCheckId[]
      ]
    )
  )
  .max(64);
