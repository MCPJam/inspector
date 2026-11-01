import { z } from "zod";

export const RETAINED_RESOURCE_SOURCE = "mcpjam/retainedResourceSource";
export const retainedResourceBindingSchema = z
  .object({
    owner: z
      .object({
        kind: z.literal("chat"),
        userId: z.string().min(1),
        harnessSessionId: z.string().min(1),
        serverId: z.string().min(1),
        connectionId: z.string().optional(),
      })
      .strict(),
    digest: z.string().min(1),
    projectId: z.string().min(1),
    chatSessionId: z.string().min(1),
  })
  .strict();
export const retainedResourceSourceSchema = retainedResourceBindingSchema
  .extend({
    version: z.literal(1),
    profile: z.string().min(1),
    attestation: z.string().min(1),
    toolCallId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  })
  .strict();
export const retainedResourceProofSchema = z
  .object({
    claim: z
      .object({
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        input: z.unknown(),
        output: z.unknown(),
      })
      .strict(),
    signature: z.string().min(1),
  })
  .strict();
export type RetainedResourceProof = z.infer<typeof retainedResourceProofSchema>;
export function hasRetainedResourceSource(result: unknown): boolean {
  const envelope = z
    .object({ _meta: z.record(z.string(), z.unknown()) })
    .safeParse(result);
  return (
    envelope.success &&
    Object.hasOwn(envelope.data._meta, RETAINED_RESOURCE_SOURCE)
  );
}
export function readRetainedResourceSource(result: unknown) {
  const envelope = z
    .object({
      _meta: z.object({
        [RETAINED_RESOURCE_SOURCE]: retainedResourceSourceSchema,
      }),
    })
    .safeParse(result);
  return envelope.success
    ? envelope.data._meta[RETAINED_RESOURCE_SOURCE]
    : undefined;
}
export function withRetainedResourceSource(
  result: unknown,
  source?: z.infer<typeof retainedResourceSourceSchema>,
) {
  const parsed = z
    .object({ _meta: z.record(z.string(), z.unknown()).optional() })
    .passthrough()
    .safeParse(result);
  if (
    !parsed.success ||
    (!source &&
      !Object.hasOwn(parsed.data._meta ?? {}, RETAINED_RESOURCE_SOURCE))
  )
    return result;
  const { [RETAINED_RESOURCE_SOURCE]: _untrusted, ...meta } =
    parsed.data._meta ?? {};
  return {
    ...parsed.data,
    _meta: {
      ...meta,
      ...(source ? { [RETAINED_RESOURCE_SOURCE]: source } : {}),
    },
  };
}

export function retainedResourceProofFor(
  claim: {
    toolCallId?: string;
    toolName: string;
    input: unknown;
    output: unknown;
  },
  metadata: unknown,
): RetainedResourceProof | undefined {
  if (!hasRetainedResourceSource(claim.output)) return undefined;
  const parsed = z
    .object({ mcpjam: z.object({ presentationSig: z.string() }) })
    .safeParse(metadata);
  return {
    claim: {
      ...claim,
      input: claim.input ?? {},
      toolCallId: claim.toolCallId ?? "",
    },
    signature: parsed.success ? parsed.data.mcpjam.presentationSig : "",
  };
}
