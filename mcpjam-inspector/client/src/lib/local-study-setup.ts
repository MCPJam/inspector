import { z } from "zod";
import { authFetch } from "./session-token";

const setupSchema = z.object({
  state: z.literal("ready"),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  workspaceDisplayRoot: z.string(),
  target: z.object({
    kind: z.literal("local-native"),
    harnessId: z.enum(["claude-code", "codex"]),
    machineId: z.string().min(1),
    workspaceGrantId: z.string().min(1),
    runtimeId: z.string().min(1),
    permissionProfile: z.string().min(1),
    policyVersion: z.string().min(1),
    localStudySessionId: z.string().min(1),
  }),
});
export type LocalStudySetup = z.infer<typeof setupSchema>;
export async function requestLocalStudySetup(args: {
  scenarioId: string;
  accessVersion: number;
  chatSessionId: string;
}): Promise<LocalStudySetup> {
  const response = await authFetch("/api/mcp/local-harness/study/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...args, accepted: true }),
  });
  const data: unknown = await response.json();
  if (response.status === 202)
    throw new Error(
      "The local client is installing. Try setup again when installation finishes.",
    );
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      error.success
        ? error.data.error
        : "Local study setup failed. Retry setup.",
    );
  }
  const result = setupSchema.safeParse(data);
  if (!result.success || Date.parse(result.data.expiresAt) <= Date.now())
    throw new Error(
      "Local study authorization is unavailable or expired. Retry setup.",
    );
  return result.data;
}
