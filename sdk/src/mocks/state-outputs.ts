import type { Tool } from "@modelcontextprotocol/server";
import { DEFAULT_LIST_LIMIT } from "./definition-types.js";
import type {
  JsonObject,
  JsonValue,
  MockDefinition,
  MockToolState,
} from "./definition-types.js";
import { checkStructuredOutput } from "./output-schema.js";
import type { MockRecordOutcome } from "./record-store.js";
import { resolveMockTools } from "./resolve-tools.js";
import { shapeResult } from "./state-ops.js";
import { bindRefs } from "./state-refs.js";
import { jsonEqual } from "./saved-answers.js";
import type { MockIssue } from "./validate-definition.js";

/** Save-time check that what a `state` tool returns fits its output schema, using the seed. */

type Ok = Extract<MockRecordOutcome, { ok: true }>;

/** Most seed records one tool is checked against; a large seed is sampled in key order. */
const MAX_CHECKED_RECORDS = 25;

/** The literal a field holds, or `undefined` when it depends on the call's input. */
function literal<T extends JsonValue>(value: T | undefined): T | undefined {
  return value !== undefined && bindRefs(value, { input: {} }).ok
    ? value
    : undefined;
}

/** The store's answers the declaration could give from the seed alone. */
function seededOutcomes(
  state: MockToolState,
  seed: Record<string, JsonObject>
): Array<{ label: string; outcome: Ok }> {
  const keys = Object.keys(seed).sort();
  const key = literal(state.key);
  const picked = (
    key === undefined ? keys : keys.filter((k) => k === key)
  ).slice(0, MAX_CHECKED_RECORDS);
  switch (state.op) {
    case "get":
      return picked.map((k) => ({
        label: `record "${k}"`,
        outcome: { ok: true, kind: "record", key: k, record: seed[k]! },
      }));
    case "patch": {
      const set = literal(state.set);
      if (!set) return [];
      return picked.map((k) => ({
        label: `record "${k}" after the patch`,
        outcome: {
          ok: true,
          kind: "record",
          key: k,
          record: { ...seed[k]!, ...set },
        },
      }));
    }
    case "delete":
      return picked.map((k) => ({
        label: `deleting "${k}"`,
        outcome: { ok: true, kind: "deleted", key: k },
      }));
    case "create": {
      const value = literal(state.value);
      return value
        ? [
            {
              label: "the new record",
              outcome: {
                ok: true,
                kind: "record",
                key: key ?? "",
                record: value,
              },
            },
          ]
        : [];
    }
    case "list": {
      const where = literal(state.where);
      const limit =
        typeof state.limit === "number" ? state.limit : DEFAULT_LIST_LIMIT;
      const records = keys
        .map((k) => seed[k]!)
        .filter((r) =>
          Object.entries(where ?? {}).every(([f, v]) => jsonEqual(r[f], v))
        )
        .slice(0, limit);
      return [
        {
          label: "the seeded records",
          outcome: { ok: true, kind: "page", records },
        },
      ];
    }
  }
}

/**
 * Every declared result a `state` tool can give from the seed, checked against
 * the tool's output schema: the definition's own, or the real tool's when
 * `realTools` is given. A result that depends on the call's input (a
 * `{{input.x}}` in the fields it reads) is checked when the call fills it. A
 * mismatch is reported at the `result` template, or at `state` without one.
 */
export function checkStateOutputs(
  definition: MockDefinition,
  realTools?: Tool[]
): MockIssue[] {
  const issues: MockIssue[] = [];
  const listed = resolveMockTools(definition, realTools ?? []).tools;
  for (const [name, tool] of Object.entries(definition.tools ?? {})) {
    const state = tool.state;
    if (!state) continue;
    const outputSchema =
      tool.outputSchema ?? listed.find((t) => t.name === name)?.outputSchema;
    if (!outputSchema) continue;
    const seed = definition.seed?.[state.collection] ?? {};
    for (const { label, outcome } of seededOutcomes(state, seed)) {
      const shaped = shapeResult(name, state, outcome, {});
      if (!shaped.ok) continue;
      const verdict = checkStructuredOutput(outputSchema, {
        structuredContent: shaped.value,
      });
      if (verdict.ok) continue;
      const path = `tools.${name}.state${state.result ? ".result" : ""}`;
      issues.push({
        code: "invalid_value",
        path,
        message: `${path} breaks the output schema of "${name}" for ${label}: ${verdict.message}. Fix ${state.result ? "the result template" : "the seed records"}, or change the output schema.`,
      });
      break;
    }
  }
  return issues;
}
