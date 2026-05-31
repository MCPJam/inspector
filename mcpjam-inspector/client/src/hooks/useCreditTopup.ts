import { useAction, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import { usePostHog } from "posthog-js/react";

export interface CreditTopupPreset {
  amountCents: number;
  amountUsd: string;
}

export interface PendingTopupContext {
  chatSessionId: string;
  message: string;
  storedAt: number;
}

const SESSION_STORAGE_KEY = "mcpjam.topup.pending";
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Allowed checkout URL prefix. Validating the prefix is a defense-in-depth
 * check that prevents an open-redirect if a compromised or buggy server
 * response ever returns an attacker-controlled URL —
 * `window.location.assign` would otherwise navigate the user anywhere.
 */
const ALLOWED_CHECKOUT_URL_PREFIX = "https://checkout.stripe.com/";

export function isAllowedCheckoutUrl(url: unknown): url is string {
  return (
    typeof url === "string" && url.startsWith(ALLOWED_CHECKOUT_URL_PREFIX)
  );
}

const formatUsd = (cents: number) => {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
};

interface RawPreset {
  amountCents?: unknown;
}

const normalizePresets = (raw: unknown): CreditTopupPreset[] | undefined => {
  // Accept either a bare array or a `{ presets: [...] }` wrapper. The
  // backend may also ship extra fields like `takeRate` or per-item
  // `creditedCents`; we deliberately ignore them so they can never reach
  // the rendered UI.
  let items: unknown = raw;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "presets" in raw
  ) {
    items = (raw as { presets?: unknown }).presets;
  }
  if (!Array.isArray(items)) return undefined;
  const presets: CreditTopupPreset[] = [];
  for (const item of items as RawPreset[]) {
    if (typeof item?.amountCents !== "number") continue;
    presets.push({
      amountCents: item.amountCents,
      amountUsd: formatUsd(item.amountCents),
    });
  }
  return presets.length > 0 ? presets : undefined;
};

export function stashPendingTopup(context: {
  chatSessionId: string;
  message: string;
}): void {
  if (typeof window === "undefined") return;
  // Don't stash a useless entry — empty chat-session id or empty message
  // means the resume path can never act on it. Avoids cross-flow noise
  // (e.g. billing-page-initiated topup writing a phantom entry that some
  // future ?topup=success effect would have to filter out).
  if (!context.chatSessionId || !context.message) return;
  try {
    const payload: PendingTopupContext = {
      chatSessionId: context.chatSessionId,
      message: context.message,
      storedAt: Date.now(),
    };
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage unavailable; fall through silently
  }
}

export function clearPendingTopup(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // noop
  }
}

/**
 * Non-destructive read of the pending top-up stash. Returns the entry if it
 * exists, is well-formed, and is within the TTL window. Returns null
 * otherwise — and on the null cases caused by a malformed or expired entry,
 * removes the bad entry from sessionStorage.
 *
 * Callers MUST call `clearPendingTopup()` themselves once they've
 * successfully acted on the entry. Splitting peek + clear avoids the
 * footgun where a read-then-fail flow loses the user's pending message.
 */
export function peekPendingTopup(): PendingTopupContext | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingTopupContext>;
    if (
      typeof parsed.chatSessionId !== "string" ||
      typeof parsed.message !== "string" ||
      typeof parsed.storedAt !== "number"
    ) {
      // Malformed entry — drop it.
      clearPendingTopup();
      return null;
    }
    if (Date.now() - parsed.storedAt > PENDING_TTL_MS) {
      // Expired — drop it.
      clearPendingTopup();
      return null;
    }
    return {
      chatSessionId: parsed.chatSessionId,
      message: parsed.message,
      storedAt: parsed.storedAt,
    };
  } catch {
    clearPendingTopup();
    return null;
  }
}

/**
 * Surface the user came from when initiating a top-up. Used as a property
 * on `credit_topup_*` PostHog events so the funnel can be split between
 * the chat-banner CTA and the billing-page Top up button.
 */
export type CreditTopupSource =
  | "chat_banner"
  | "billing_page"
  | "limit_modal";

interface StartCheckoutInput {
  amountCents: number;
  chatSessionId: string;
  lastUserMessage: string;
  returnUrl?: string;
  source: CreditTopupSource;
}

export interface UseCreditTopupPresetsOptions {
  /** When true, the underlying Convex query is skipped entirely. */
  skip?: boolean;
}

export function useCreditTopupPresets(
  options?: UseCreditTopupPresetsOptions,
): { presets: CreditTopupPreset[] | undefined; isLoading: boolean } {
  const skip = options?.skip === true;
  const presetsRaw = useQuery(
    "billing:getCreditTopupPresets" as any,
    skip ? "skip" : (undefined as any),
  ) as unknown | undefined;
  // Memoize on the raw query reference. Convex returns a stable reference
  // when the underlying data is unchanged, so the normalized array stays
  // referentially stable across renders. Keeps downstream effects/memos
  // that depend on `presets` from re-running when nothing actually changed.
  const presets = useMemo(() => normalizePresets(presetsRaw), [presetsRaw]);
  const isLoading = !skip && presetsRaw === undefined;
  return { presets, isLoading };
}

export function useCreditTopup() {
  const { presets, isLoading: presetsLoading } = useCreditTopupPresets();
  const posthog = usePostHog();

  const createCheckoutSession = useAction(
    "billing:createCreditCheckoutSession" as any,
  );

  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = useCallback(
    async ({
      amountCents,
      chatSessionId,
      lastUserMessage,
      returnUrl,
      source,
    }: StartCheckoutInput): Promise<void> => {
      setIsStartingCheckout(true);
      setError(null);
      posthog?.capture("credit_topup_checkout_started", {
        amount_cents: amountCents,
        source,
      });
      stashPendingTopup({ chatSessionId, message: lastUserMessage });
      // Track the most specific failure category we know about. Defaults to
      // `action_threw` (the fallback when the Convex action itself rejects)
      // and gets refined by the URL guards below.
      let errorKind: "missing_url" | "invalid_url" | "action_threw" =
        "action_threw";
      try {
        const result = (await createCheckoutSession({
          amountCents,
          ...(returnUrl ? { returnUrl } : {}),
        } as any)) as { checkoutUrl?: string } | null;
        const checkoutUrl = result?.checkoutUrl;
        if (typeof checkoutUrl !== "string" || checkoutUrl.length === 0) {
          errorKind = "missing_url";
          throw new Error("Checkout URL missing from response");
        }
        if (!isAllowedCheckoutUrl(checkoutUrl)) {
          // Defense-in-depth: don't navigate to URLs that aren't on the
          // allowed checkout host even if the server told us to.
          errorKind = "invalid_url";
          throw new Error("Refusing to redirect to non-Stripe checkout URL");
        }
        window.location.assign(checkoutUrl);
      } catch (err) {
        posthog?.capture("credit_topup_checkout_failed", {
          amount_cents: amountCents,
          error_kind: errorKind,
          source,
        });
        clearPendingTopup();

        const message =
          err instanceof Error ? err.message : "Failed to start checkout";
        setError(message);
        throw err;
      } finally {
        setIsStartingCheckout(false);
      }
    },
    [createCheckoutSession, posthog],
  );

  return {
    presets,
    presetsLoading,
    startCheckout,
    isStartingCheckout,
    error,
  };
}
