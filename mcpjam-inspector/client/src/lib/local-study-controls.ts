import { z } from "zod";
import { authFetch } from "./session-token";
const admissionSchema = z.object({
  harnessId: z.enum(["claude-code", "codex"]),
  modelSourceReady: z.boolean(),
});
export type LocalStudyAdmission = z.infer<typeof admissionSchema>;
async function post(
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await authFetch(`/api/mcp/local-harness/study/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      error.success
        ? error.data.error
        : "Could not update local study access. Sign in and try again.",
    );
  }
  return data;
}
export async function fetchLocalStudyAdmission(
  args: { scenarioId: string; accessVersion: number },
  signal?: AbortSignal,
): Promise<LocalStudyAdmission | null> {
  const parsed = z
    .object({ available: admissionSchema.nullable() })
    .safeParse(await post("availability", args, signal));
  if (!parsed.success)
    throw new Error("Local availability could not be verified.");
  return parsed.data.available;
}
export async function revokeLocalStudyAccess(
  reservationId: string,
): Promise<{ revoked: true; cleanupComplete: boolean }> {
  const parsed = z
    .object({ revoked: z.literal(true), cleanupComplete: z.boolean() })
    .safeParse(await post("revoke", { reservationId }));
  if (!parsed.success)
    throw new Error(
      "Could not confirm revocation. Check your connection and try again.",
    );
  return parsed.data;
}
