import { z } from "zod";

const params = z.strictObject({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()),
});
/** The settings route derives the actual MCP operation from this original intent. */
export const settingsOperationIntent = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("read") }),
  z.strictObject({
    method: z.literal("update"),
    set: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ method: z.literal("action"), toolName: z.string().min(1) }),
  z.strictObject({
    method: z.literal("app/call"),
    childToken: z.string().min(1),
    params,
  }),
]);
export type SettingsOperationIntent = z.infer<typeof settingsOperationIntent>;

export const settingsContinuation = z.strictObject({
  continuationId: z.string().min(1).max(256),
  round: z.number().int().positive(),
  responsesBlobId: z.string().min(1).max(512),
});
