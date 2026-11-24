import { MCPJAM_HOSTED_APP_ORIGIN } from "./oauth/constants";
import { browserAnalyticsOptedOut, getRuntimeConfig } from "./runtime-config";
// The campaign stays in an HttpOnly, host-only marketing-site cookie. The
// app remembers only the expiry of the last visit it successfully attributed.
const receiptName = "__Host-mcpjam_signup_consumed";
const productionWebsiteOrigins = [
  "https://www.mcpjam.com",
  "https://mcpjam.com",
] as const;
export type SignupCampaign = { label: string; expiresAt: number };

function consumedThrough(): number {
  const receipt = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(receiptName + "="));
  return Number(receipt?.slice(receiptName.length + 1)) || 0;
}

function websiteOrigins(): readonly string[] {
  if (location.origin === MCPJAM_HOSTED_APP_ORIGIN)
    return productionWebsiteOrigins;
  const config = getRuntimeConfig();
  if (
    location.protocol !== "https:" ||
    config?.signupCampaignAppOrigin !== location.origin
  )
    return [];
  return (config.signupCampaignWebsiteOrigins ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => {
      try {
        return value.startsWith("https://") && new URL(value).origin === value;
      } catch {
        return false;
      }
    });
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
    const { label, expiresAt } = await response.json();
    if (
      typeof label === "string" &&
      /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/.test(label) &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > Date.now() &&
      expiresAt <= Date.now() + 1_800_000
    ) {
      return { label, expiresAt };
    }
  } catch {
    /* One host can redirect, be offline or have no eligible visit. */
  }
}

export async function readSignupCampaign(
  canCapture: () => boolean,
): Promise<SignupCampaign | undefined> {
  try {
    if (browserAnalyticsOptedOut() || !canCapture()) return;
    const origins = websiteOrigins();
    if (!origins.length) return;
    const signal = AbortSignal.timeout(1200);
    const visits = await Promise.all(
      origins.map((origin) => fromWebsite(origin, signal)),
    );
    if (browserAnalyticsOptedOut() || !canCapture()) return;
    const latest = visits
      .filter((v): v is SignupCampaign => !!v)
      .sort((a, b) => b.expiresAt - a.expiresAt)[0];
    if (
      latest &&
      latest.expiresAt > Date.now() &&
      latest.expiresAt > consumedThrough()
    )
      return latest;
  } catch {
    /* Storage and network failures must not interrupt account setup. */
  }
}

export function acknowledgeSignupCampaign({ expiresAt }: SignupCampaign) {
  try {
    const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
    if (seconds <= 0 || consumedThrough() >= expiresAt) return;
    document.cookie =
      receiptName +
      "=" +
      expiresAt +
      "; Path=/; Max-Age=" +
      seconds +
      "; Secure; SameSite=Lax";
  } catch {
    /* Receipt storage is best effort. */
  }
}
