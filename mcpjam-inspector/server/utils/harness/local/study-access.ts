import { z } from "zod";

const reservationSchema = z.object({
  reservationId: z.string().min(1),
  scenarioId: z.string().min(1),
  projectId: z.string().min(1),
  chatSessionId: z.string().min(1),
  accessVersion: z.number().int().nonnegative(),
  expiresAt: z.number(),
});
export type LocalStudyReservation = z.infer<typeof reservationSchema>;
type StudyAccessRequest =
  | {
      action: "reserve";
      scenarioId: string;
      accessVersion: number;
      chatSessionId: string;
      machineId: string;
      keyId: string;
    }
  | {
      action: "validate";
      reservationId: string;
      machineId: string;
      keyId: string;
    };

/** The backend owns conversation identity; this response is not a local grant. */
export async function requestLocalStudyReservation(
  bearer: string,
  request: StudyAccessRequest,
): Promise<LocalStudyReservation> {
  if (!process.env.CONVEX_HTTP_URL)
    throw new Error("Study authorization is unavailable on this server.");
  const response = await fetch(
    new URL("/web/scenario/local-session", process.env.CONVEX_HTTP_URL),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: bearer.startsWith("Bearer ")
          ? bearer
          : `Bearer ${bearer}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body: unknown = await response.json();
  const result = z
    .object({ ok: z.literal(true), reservation: reservationSchema })
    .safeParse(body);
  if (
    !response.ok ||
    !result.success ||
    result.data.reservation.expiresAt <= Date.now()
  ) {
    throw new Error(
      "This study preview could not be authorized for this account and installation. Reopen the study and retry.",
    );
  }
  return result.data.reservation;
}
