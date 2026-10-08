/** Official OpenAI schemas live at the inspector's Node 22/build boundary. */
import { z } from "zod";
import {
  OpenAIMessageParamsSchema,
  OpenAIResourceWriteParamsSchema,
  OpenAIResourceWriteResultSchema,
} from "@openai/mcp-extensions/app";
import {
  OpenAIFormSchema,
  OpenAIFormResultSchema,
  createOpenAIFormContentSchema,
} from "@openai/mcp-extensions/server";

export {
  OpenAIMessageParamsSchema,
  OpenAIResourceWriteParamsSchema,
  OpenAIResourceWriteResultSchema,
};

export const OPENAI_LEGACY_FORM_METHOD = "openai/elicitation/create";
/** The client capability (`extensions` key) that method's handler answers. */
export const OPENAI_LEGACY_FORM_EXTENSION = "openai/elicitation";
export const OpenAIFormParamsSchema = z
  .object({
    mode: z.literal("form"),
    message: z.string(),
    requestedSchema: OpenAIFormSchema,
  })
  .passthrough();

/**
 * The request envelope only. The requested schema stays exactly as the
 * server sent it: the host compiles the whole form (`compilePluginForm`) and
 * reports it Unsupported, rather than a schema parser silently stripping an
 * input or constraint it doesn't know before anyone sees it. `mode` may be
 * omitted, as in `elicitation/create` (form is the default).
 */
export const OpenAIFormRequestParamsSchema = z
  .object({
    mode: z.literal("form").optional(),
    message: z.string(),
    requestedSchema: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const openAILegacyFormSchemas = {
  params: OpenAIFormRequestParamsSchema,
  result: OpenAIFormResultSchema,
};

/** Envelope only; the form is admitted whole by `compilePluginForm`. */
export function parseOpenAIForm(params: unknown) {
  return OpenAIFormRequestParamsSchema.parse(params);
}

/** Use for both transports; a generic JSON Schema validator misses file selections. */
export function validateOpenAIFormContent(schema: unknown, content: unknown) {
  const form = OpenAIFormSchema.safeParse(schema);
  if (!form.success)
    return { valid: false, error: "Unsupported OpenAI form schema" };
  const result = createOpenAIFormContentSchema(form.data).safeParse(content);
  return result.success
    ? { valid: true }
    : {
        valid: false,
        error: "Form content does not satisfy the requested schema",
      };
}
