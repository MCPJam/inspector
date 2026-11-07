import { z } from "zod";

export const MAX_TURN_AUTHORIZATION_MS = 2 * 60 * 60_000;

export const turnAuthorizationIdentity = z.object({
  handle: z.string().uuid(),
  projectId: z.string().min(1).max(256),
  chatSessionId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  requestId: z.string().uuid(),
}).strict();
export type TurnAuthorizationIdentity = z.infer<typeof turnAuthorizationIdentity>;

export const turnAuthorizationPart = z.object({
  type: z.literal("data-turn-authorization"),
  data: turnAuthorizationIdentity.extend({ tokenExpiresAt: z.number().finite().positive(), expiresAt: z.number().finite().positive().refine((value) => value <= Date.now() + MAX_TURN_AUTHORIZATION_MS) }),
});
