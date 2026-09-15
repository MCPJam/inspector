import { loadStripeJs } from "./seat-payment-stripe";
export interface AutoTopupCardSession {
  confirm: (clientSecret: string, setupIntentId: string) => Promise<void>;
  destroy: () => void;
}
/** Card details remain inside Stripe Elements; secrets exist only in memory. */
export async function mountAutoTopupCard(
  publishableKey: string,
  element: HTMLElement,
): Promise<AutoTopupCardSession> {
  if (!/^pk_(test|live)_/.test(publishableKey))
    throw new Error("Card setup is not configured for this environment.");
  await loadStripeJs();
  const stripe = window.Stripe?.(publishableKey);
  if (!stripe?.elements || !stripe.confirmCardSetup)
    throw new Error("Could not initialize secure card setup.");
  const card = stripe.elements().create("card");
  card.mount(element);
  return {
    async confirm(clientSecret, setupIntentId) {
      const result = await stripe.confirmCardSetup!(clientSecret, {
        payment_method: { card },
      });
      if (result.error)
        throw new Error(
          result.error.message || "Card setup was not completed.",
        );
      if (
        result.setupIntent?.status !== "succeeded" ||
        result.setupIntent.id !== setupIntentId
      )
        throw new Error(
          "Card setup was not completed. Check its status before continuing.",
        );
    },
    destroy: () => card.destroy(),
  };
}
