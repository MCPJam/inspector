import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STRIPE_SCRIPT_SELECTOR = 'script[src="https://js.stripe.com/v3/"]';

async function importStripeHelpers() {
  return await import("../seat-payment-stripe");
}

function getStripeScript(): HTMLScriptElement {
  const script = document.querySelector<HTMLScriptElement>(
    STRIPE_SCRIPT_SELECTOR
  );
  if (!script) {
    throw new Error("Stripe script was not added");
  }
  return script;
}

function setLoadedStripe() {
  const confirmCardPayment = vi.fn().mockResolvedValue({
    paymentIntent: { status: "succeeded" },
  });
  window.Stripe = vi.fn(() => ({ confirmCardPayment }));
  return confirmCardPayment;
}

describe("confirmSeatPaymentWithStripe", () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.Stripe;
    document.querySelectorAll(STRIPE_SCRIPT_SELECTOR).forEach((script) => {
      script.remove();
    });
  });

  afterEach(() => {
    delete window.Stripe;
    document.querySelectorAll(STRIPE_SCRIPT_SELECTOR).forEach((script) => {
      script.remove();
    });
  });

  it("retries loading Stripe.js after a newly-created script fails", async () => {
    const { confirmSeatPaymentWithStripe } = await importStripeHelpers();

    const firstAttempt = confirmSeatPaymentWithStripe({
      publishableKey: "pk_test_fake",
      clientSecret: "cs_test_fake",
    });
    getStripeScript().dispatchEvent(new Event("error"));

    await expect(firstAttempt).rejects.toThrow("Failed to load Stripe");
    expect(document.querySelector(STRIPE_SCRIPT_SELECTOR)).toBeNull();

    const secondAttempt = confirmSeatPaymentWithStripe({
      publishableKey: "pk_test_fake",
      clientSecret: "cs_test_fake",
    });
    const confirmCardPayment = setLoadedStripe();
    getStripeScript().dispatchEvent(new Event("load"));

    await expect(secondAttempt).resolves.toBeUndefined();
    expect(confirmCardPayment).toHaveBeenCalledWith("cs_test_fake");
  });

  it("retries loading Stripe.js after an existing script fails", async () => {
    const existingScript = document.createElement("script");
    existingScript.src = "https://js.stripe.com/v3/";
    document.head.appendChild(existingScript);
    const { confirmSeatPaymentWithStripe } = await importStripeHelpers();

    const firstAttempt = confirmSeatPaymentWithStripe({
      publishableKey: "pk_test_fake",
      clientSecret: "cs_test_fake",
    });
    existingScript.dispatchEvent(new Event("error"));

    await expect(firstAttempt).rejects.toThrow("Failed to load Stripe");
    expect(document.querySelector(STRIPE_SCRIPT_SELECTOR)).toBeNull();

    const secondAttempt = confirmSeatPaymentWithStripe({
      publishableKey: "pk_test_fake",
      clientSecret: "cs_test_fake",
    });
    const confirmCardPayment = setLoadedStripe();
    getStripeScript().dispatchEvent(new Event("load"));

    await expect(secondAttempt).resolves.toBeUndefined();
    expect(confirmCardPayment).toHaveBeenCalledWith("cs_test_fake");
  });
});
