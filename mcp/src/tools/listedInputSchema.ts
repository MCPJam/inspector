/**
 * The input schema a tool advertises in `tools/list`, as opposed to the one it
 * validates with. Clients hand the advertised schema to the model on every
 * call, so it leaves out what the model never needs: deprecated aliases
 * (`deprecatedProperties.ts`) and a `$schema` that restates MCP's default
 * dialect (`impliedDialect.ts`). Validation is the schema's own and accepts
 * everything it did before.
 */
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { omitDeprecatedProperties } from "./deprecatedProperties.js";
import { omitImpliedDialect } from "./impliedDialect.js";

/**
 * `schema` with its advertised input JSON Schema trimmed. Typed as `S`
 * because the SDK reads a tool's schema only through `~standard`, which is
 * all this keeps.
 */
export function withListedInputSchema<S extends StandardSchemaWithJSON>(
  schema: S
): S {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
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
