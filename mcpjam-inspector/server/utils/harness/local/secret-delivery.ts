import { environmentSelectsSecretDelivery } from "../environment-secret-delivery.js";

/** Local processes cannot receive E2B egress-injected secrets. Check only
 * selected, caller-visible metadata; no secret values are fetched here. */
export async function assertLocalSecretDelivery(args: {
  bearer: string;
  projectId: string;
  environmentId?: string;
  environmentUnresolvedReason?: string;
}): Promise<void> {
  if (args.environmentUnresolvedReason) {
    throw new Error(
      "Cannot verify secret delivery for this local run's environment.",
    );
  }
  if (!args.environmentId) return;
  if (
    await environmentSelectsSecretDelivery(
      args.bearer,
      { projectId: args.projectId, environmentId: args.environmentId },
      "brokered",
    )
  ) {
    throw new Error(
      "This environment selects brokered secrets, which require cloud execution. " +
      "Local execution supports materialized secrets only.",
    );
  }
}
