import { z } from "zod";

export const clientActionReceiptSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().nonnegative(),
  actor: z.enum(["persona", "model", "scripted"]),
  surface: z.literal("client"),
  kind: z.enum(["question", "approval"]),
  outcome: z.enum([
    "accepted",
    "declined",
    "cancelled",
    "approved",
    "denied",
    "expired",
    "invalid",
    "unavailable",
    "unsupported",
  ]),
  elapsedMs: z.number().nonnegative(),
  startedAt: z.number().nonnegative(),
  serverId: z.string().min(1).max(256).optional(),
  toolName: z.string().min(1).max(256).optional(),
  invocationId: z.string().min(1).max(256).optional(),
});

export type ClientActionReceipt = z.infer<typeof clientActionReceiptSchema>;
