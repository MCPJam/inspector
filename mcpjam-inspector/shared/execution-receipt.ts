import { z } from "zod";

export const runtimeExecutionSchema = z.strictObject({
  engine: z.string().regex(/^harness:[a-z][a-z0-9-]*$/),
  venue: z.enum(["hosted", "local"]),
  runtimeVersion: z.string().min(1).nullable(),
});
export type RuntimeExecution = z.infer<typeof runtimeExecutionSchema>;

export const executionReceiptSchema = z.strictObject({
  engine: z.union([z.literal("emulated"), runtimeExecutionSchema.shape.engine]),
  venue: runtimeExecutionSchema.shape.venue,
  runtimeVersion: runtimeExecutionSchema.shape.runtimeVersion,
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

/** Observational evidence must never turn an already spent/persisted turn into a retryable failure. */
export function executionReceipt(
  runtime: RuntimeExecution | undefined,
  expectedEngine: string,
  sessionId: string,
  turnId: string,
  emulatedVenue: "hosted" | "local" = "hosted",
) {
  if (expectedEngine !== (runtime?.engine ?? "emulated")) {
    return undefined;
  }
  const parsed = executionReceiptSchema.safeParse({
    ...(runtime ?? {
      engine: "emulated",
      venue: emulatedVenue,
      runtimeVersion: null,
    }),
    sessionId,
    turnId,
  });
  return parsed.success ? parsed.data : undefined;
}
