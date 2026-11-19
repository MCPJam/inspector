import type { HarnessV1 } from "@ai-sdk/harness";
import { jsonSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import { z } from "zod";

/** Validate adapter state without discarding a host-owned continuation field. */
export function preserveLifecycleDataField(
  schema: NonNullable<HarnessV1["lifecycleStateSchema"]>,
  name: string,
  fieldSchema: z.ZodType,
) {
  const resolved = typeof schema === "function" ? schema() : schema;
  const validator =
    "jsonSchema" in resolved
      ? jsonSchema(resolved.jsonSchema, {
          validate: resolved.validate?.bind(resolved),
        })
      : resolved;
  return jsonSchema(
    { type: "object" },
    {
      validate: async (value) => {
        const extension = z
          .object({ [name]: fieldSchema.optional() })
          .passthrough()
          .safeParse(value);
        if (!extension.success)
          return { success: false, error: extension.error };
        const field = extension.data[name];
        const data = { ...extension.data };
        delete data[name];
        const result = await safeValidateTypes({
          value: data,
          schema: validator,
        });
        if (!result.success || field === undefined) return result;
        const parsed = z
          .record(z.string(), z.unknown())
          .safeParse(result.value);
        return parsed.success
          ? { success: true, value: { ...parsed.data, [name]: field } }
          : { success: false, error: parsed.error };
      },
    },
  );
}
