import type { CompleteRequestParams } from "@modelcontextprotocol/server";
import { MAX_COMPLETION_VALUES } from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import { forwardToReal } from "./item-handlers.js";
import type { ItemHandlerContext } from "./item-handlers.js";

type Obj = Record<string, unknown>;

/** The most suggestions a result may carry (the spec's cap). */
const MAX_RESULT_VALUES = 100;

/** Whether the definition lists suggestions, so the mock declares `completions`. */
export function definitionCompletes(definition: MockDefinition): boolean {
  const { prompts, resourceTemplates } = definition.completions ?? {};
  return [prompts, resourceTemplates].some(
    (map) => Object.keys(map ?? {}).length > 0
  );
}

/**
 * `completion/complete` for a prompt or resource-template argument. The
 * definition's list for that argument answers, filtered by what the user has
 * typed (case-insensitive prefix, definition order, at most 100 with `total`
 * and `hasMore`). An argument the definition says nothing about goes to the
 * real server, after the host allows it, when the real server has
 * completions; a mock with no real completions has no suggestions for it. The
 * server SDK has already checked the request's shape.
 */
export async function answerCompletion(
  c: ItemHandlerContext,
  params: CompleteRequestParams,
  signal: AbortSignal
): Promise<Obj> {
  const { ref, argument } = params;
  const own =
    ref.type === "ref/prompt"
      ? c.definition.completions?.prompts?.[ref.name]?.[argument.name]
      : c.definition.completions?.resourceTemplates?.[ref.uri]?.[argument.name];
  if (own === undefined && c.realCapabilities.completions) {
    return forwardToReal(c, "completion/complete", { ...params }, signal);
  }
  const typed = argument.value.toLowerCase();
  const matches = (own ?? [])
    .slice(0, MAX_COMPLETION_VALUES)
    .filter((value) => value.toLowerCase().startsWith(typed));
  return {
    completion: {
      values: matches.slice(0, MAX_RESULT_VALUES),
      total: matches.length,
      hasMore: matches.length > MAX_RESULT_VALUES,
    },
  };
}
