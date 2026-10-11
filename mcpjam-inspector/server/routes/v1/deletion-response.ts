import { z } from "zod";

const acceptedDeletion = z.object({
  accepted: z.literal(true),
  requestId: z.string().min(1),
  state: z.string(),
  deleted: z.literal(false),
});

/** Never turn an asynchronous backend acknowledgement into completed deletion. */
export function deletionResponse(result: unknown) {
  if (
    result &&
    typeof result === "object" &&
    "accepted" in result &&
    result.accepted === true
  ) {
    return acceptedDeletion.parse(result);
  }
  return { deleted: true as const };
}
