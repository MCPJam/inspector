import { ERROR_MESSAGES } from "@/lib/error-messages";
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
    throw new Error(ERROR_MESSAGES.cardSetupIsNotConfiguredForThisEnvironment);
  await loadStripeJs();
  const stripe = window.Stripe?.(publishableKey);
  if (!stripe?.elements || !stripe.confirmCardSetup)
    throw new Error(ERROR_MESSAGES.couldNotInitializeSecureCardSetup);
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
          ERROR_MESSAGES.cardSetupWasNotCompletedCheckItsStatusBeforeContinuing,
        );
    },
    destroy: () => card.destroy(),
  };
}
