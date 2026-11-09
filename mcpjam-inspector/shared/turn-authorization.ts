import { z } from "zod";

export const MAX_TURN_AUTHORIZATION_MS = 2 * 60 * 60_000;

const common = z
  .object({
    handle: z.string().uuid(),
    projectId: z.string().min(1).max(256),
    requestId: z.string().uuid(),
  })
  .strict();
export const pluginOperationIdentity = z
  .object({
    workspaceId: z.string().min(1).max(256),
    instanceId: z.string().uuid(),
    generation: z.number().int().positive(),
    hostId: z.string().min(1).max(256),
    serverId: z.string().min(1).max(256),
    invocationId: z.string().uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const chat = common.extend({
  chatSessionId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
});
const plugin = common.extend({ pluginOperation: pluginOperationIdentity });
export const turnAuthorizationIdentity = z.union([chat, plugin]);
export type TurnAuthorizationIdentity = z.infer<
  typeof turnAuthorizationIdentity
>;
export type TurnAuthorizationScope =
  Omit<z.infer<typeof chat>, "handle"> | Omit<z.infer<typeof plugin>, "handle">;
const deadlines = {
  tokenExpiresAt: z.number().finite().positive(),
  expiresAt: z
    .number()
    .finite()
    .positive()
    .refine((value) => value <= Date.now() + MAX_TURN_AUTHORIZATION_MS),
};

export const turnAuthorizationPart = z.object({
  type: z.literal("data-turn-authorization"),
  data: z.union([chat.extend(deadlines), plugin.extend(deadlines)]),
});
