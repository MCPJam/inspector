import { z } from "zod";

export const runtimeExecutionSchema = z.strictObject({
  engine: z.string().regex(/^harness:[a-z][a-z0-9-]*$/),
  venue: z.enum(["hosted", "local-native"]),
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

/** A receipt is created only after an engine returned a successful turn. */
export function executionReceipt(
  runtime: RuntimeExecution | undefined,
  expectedEngine: string,
  sessionId: string,
  turnId: string,
) {
  if (expectedEngine !== (runtime?.engine ?? "emulated")) {
    throw new Error("The runtime did not provide the selected engine receipt");
  }
  return executionReceiptSchema.parse({
    ...(runtime ?? {
      engine: "emulated",
      venue: "hosted",
      runtimeVersion: null,
    }),
    sessionId,
    turnId,
  });
}
