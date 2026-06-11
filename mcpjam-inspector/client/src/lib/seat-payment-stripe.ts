type StripeConfirmCardPaymentResult = {
  error?: {
    message?: string;
  };
  paymentIntent?: {
    status?: string;
  };
};

type StripeClient = {
  confirmCardPayment: (
    clientSecret: string,
  ) => Promise<StripeConfirmCardPaymentResult>;
};

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeClient | null;
  }
}

let stripeJsPromise: Promise<void> | null = null;

function loadStripeJs(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Stripe is only available in the browser"));
  }
  if (window.Stripe) {
    return Promise.resolve();
  }
  if (stripeJsPromise) {
    return stripeJsPromise;
  }

  stripeJsPromise = new Promise((resolve, reject) => {
    const rejectAndReset = (failedScript: HTMLScriptElement) => {
      failedScript.remove();
      stripeJsPromise = null;
      reject(new Error("Failed to load Stripe"));
    };
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://js.stripe.com/v3/"]',
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => rejectAndReset(existingScript),
        {
          once: true,
        }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3/";
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => rejectAndReset(script), {
      once: true,
    });
    document.head.appendChild(script);
  });

  return stripeJsPromise;
}

export async function confirmSeatPaymentWithStripe({
  publishableKey,
  clientSecret,
}: {
  publishableKey: string;
  clientSecret: string;
}): Promise<void> {
  await loadStripeJs();

  const stripe = window.Stripe?.(publishableKey);
  if (!stripe) {
    throw new Error("Failed to initialize Stripe");
  }

  const result = await stripe.confirmCardPayment(clientSecret);
  if (result.error) {
    throw new Error(result.error.message || "Payment was not completed");
  }
}
