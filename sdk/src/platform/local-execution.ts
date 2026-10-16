import { z } from "zod";

export const localExecutionAuthorizationSchema = z.strictObject({
  harnessId: z.enum(["claude-code", "codex"]),
  allowUnattended: z.literal(true),
  workspacePath: z.string().min(1).optional(),
});
export const localExecutionTargetSchema = z.strictObject({
  kind: z.literal("local-native"),
  scope: z.literal("unattended"),
  harnessId: z.enum(["claude-code", "codex"]),
  machineId: z.string().min(1),
  workspaceGrantId: z.string().min(1),
  runtimeId: z.string().min(1),
  permissionProfile: z.literal("unrestricted"),
  policyVersion: z.string().min(1),
  grantToken: z.string().min(16).max(256),
});
export const platformExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hosted") }),
  localExecutionTargetSchema,
]);
export type PlatformExecutionTarget = z.infer<
  typeof platformExecutionTargetSchema
>;
export type LocalExecutionAuthorization = z.infer<
  typeof localExecutionAuthorizationSchema
>;
export type PlatformLocalExecutionGrant = {
  target: z.infer<typeof localExecutionTargetSchema>;
  expiresAt: string;
};
