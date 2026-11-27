import { signupCampaignWebsiteOrigins } from "@/shared/signup-campaign-origins";
import { browserAnalyticsOptedOut, getRuntimeConfig } from "./runtime-config";
// The campaign stays in an HttpOnly, host-only marketing-site cookie. The
// app remembers only the expiry of the last visit it successfully attributed.
const receiptName = "__Host-mcpjam_signup_consumed";
export type SignupCampaign = { label: string; expiresAt: number; visitId: string };

function consumedThrough(): number {
  const receipt = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(receiptName + "="));
  return Number(receipt?.slice(receiptName.length + 1)) || 0;
}

async function fromWebsite(
  origin: string,
  signal: AbortSignal,
): Promise<SignupCampaign | undefined> {
  try {
    const response = await fetch(origin + "/api/signup-campaign", {
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (response.status !== 200) return;
    const { label, expiresAt, visitId } = await response.json();
    if (
      typeof label === "string" &&
      /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/.test(label) &&
      typeof visitId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(visitId) &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > 0
    ) {
      return { label, expiresAt, visitId };
    }
  } catch {
    /* One host can redirect, be offline or have no eligible visit. */
  }
}

export async function readSignupCampaign(
  canCapture: () => boolean,
  signal = AbortSignal.timeout(1200),
): Promise<SignupCampaign | undefined> {
  try {
    if (browserAnalyticsOptedOut() || !canCapture()) return;
    const origins = signupCampaignWebsiteOrigins(location.origin, getRuntimeConfig());
    if (!origins.length) return;
    if (signal.aborted) return;
    const visits = await Promise.all(
      origins.map((origin) => fromWebsite(origin, signal)),
    );
    if (browserAnalyticsOptedOut() || !canCapture()) return;
    const latest = visits
      .filter((v): v is SignupCampaign => !!v)
      .sort((a, b) => b.expiresAt - a.expiresAt)[0];
    if (
      latest &&
      latest.expiresAt > consumedThrough()
    )
      return latest;
  } catch {
    /* Storage and network failures must not interrupt account setup. */
  }
}

// Web Locks coordinate tabs. Older browsers still serialize claims across hook
// instances within this page. A rejected mutation must release the next waiter.
const localClaims = new Map<string, Promise<void>>();

export async function withSignupCampaignClaim(
  visitId: string,
  signal: AbortSignal,
  claim: () => Promise<void>,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (navigator.locks) {
    let acquired = false;
    try {
      await navigator.locks.request("mcpjam-signup-campaign-" + visitId, { signal }, async () => {
        acquired = true;
        await claim();
      });
      return true;
    } catch (error) {
      if (acquired) throw error;
      return false;
    }
  }
  while (localClaims.has(visitId)) {
    let release!: () => void;
    const aborted = new Promise<void>((resolve) => { release = resolve; });
    signal.addEventListener("abort", release, { once: true });
    try {
      await Promise.race([localClaims.get(visitId), aborted]);
    } finally {
      signal.removeEventListener("abort", release);
    }
    if (signal.aborted) return false;
  }
  let release!: () => void;
  localClaims.set(visitId, new Promise<void>((resolve) => { release = resolve; }));
  try {
    await claim();
    return true;
  } finally {
    localClaims.delete(visitId);
    release();
  }
}

export function acknowledgeSignupCampaign({ expiresAt }: SignupCampaign) {
  try {
    // The website has already checked expiry against its own clock. Keep the
    // watermark for one full visit window. Newer visits still pass immediately.
    if (consumedThrough() >= expiresAt) return;
    document.cookie =
      receiptName +
      "=" +
      expiresAt +
      "; Path=/; Max-Age=1800; Secure; SameSite=Lax";
  } catch {
    /* Receipt storage is best effort. */
  }
}
