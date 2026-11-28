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
    connectionCapabilities: z.record(z.string(), z.unknown()).optional(),
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
/** The host could not bind this App to the account that produced it. */
export const RETAINED_RESOURCE_REFUSED = "mcpjam/retainedResourceRefused";
export function isRetainedResourceRefused(result: unknown): boolean {
  const envelope = z
    .object({ _meta: z.object({ [RETAINED_RESOURCE_REFUSED]: z.literal(true) }) })
    .safeParse(result);
  return envelope.success;
}
/** Only the host marks a result; a server's own copy of either key is dropped. */
export function withRetainedResourceSource(
  result: unknown,
  source?: z.infer<typeof retainedResourceSourceSchema>,
  refused = false,
) {
  const parsed = z
    .object({ _meta: z.record(z.string(), z.unknown()).optional() })
    .passthrough()
    .safeParse(result);
  const meta = parsed.success ? (parsed.data._meta ?? {}) : {};
  if (
    !parsed.success ||
    (!source &&
      !refused &&
      !Object.hasOwn(meta, RETAINED_RESOURCE_SOURCE) &&
      !Object.hasOwn(meta, RETAINED_RESOURCE_REFUSED))
  )
    return result;
  const {
    [RETAINED_RESOURCE_SOURCE]: _untrustedSource,
    [RETAINED_RESOURCE_REFUSED]: _untrustedRefusal,
    ...rest
  } = meta;
  return {
    ...parsed.data,
    _meta: {
      ...rest,
      ...(source
        ? { [RETAINED_RESOURCE_SOURCE]: source }
        : refused
          ? { [RETAINED_RESOURCE_REFUSED]: true }
          : {}),
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
