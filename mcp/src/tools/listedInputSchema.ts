/**
 * The input schema a tool advertises in `tools/list`, as opposed to the one it
 * validates with. Clients hand the advertised schema to the model on every
 * call, so it leaves out what the model never needs: deprecated aliases
 * (`deprecatedProperties.ts`) and a `$schema` that restates MCP's default
 * dialect (`impliedDialect.ts`). Validation is the schema's own and accepts
 * everything it did before; only the message for a missing argument changes
 * (`missingArguments.ts`).
 */
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { omitDeprecatedProperties } from "./deprecatedProperties.js";
import { omitImpliedDialect } from "./impliedDialect.js";
import { explainMissingArguments } from "./missingArguments.js";

/**
 * `schema` with its advertised input JSON Schema trimmed. Typed as `S`
 * because the SDK reads a tool's schema only through `~standard`, which is
 * all this keeps.
 */
export function withListedInputSchema<S extends StandardSchemaWithJSON>(
  schema: S
): S {
  const standard = schema["~standard"];
  let described: unknown;
  const explain = (
    result: Awaited<ReturnType<typeof standard.validate>>,
    value: unknown
  ) => {
    if (!result.issues) return result;
    described ??= standard.jsonSchema.input({ target: "draft-2020-12" });
    return {
      ...result,
      issues: explainMissingArguments(result.issues, value, described),
    };
  };
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => {
        const result = standard.validate(value);
        return result instanceof Promise
          ? result.then((settled) => explain(settled, value))
          : explain(result, value);
      },
      jsonSchema: {
        input: (options) =>
          omitImpliedDialect(
            omitDeprecatedProperties(standard.jsonSchema.input(options))
          ),
        output: (options) => standard.jsonSchema.output(options),
      },
    },
  } as S;
}
