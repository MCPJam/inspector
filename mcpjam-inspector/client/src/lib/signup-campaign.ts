// The campaign stays in an HttpOnly, host-only marketing-site cookie. The
// app remembers only the expiry of the last visit it successfully attributed.
const receiptName = "__Host-mcpjam_signup_consumed";
const websiteOrigins = [
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

function allowed(canCapture: () => boolean): boolean {
  return (
    location.origin === "https://app.mcpjam.com" &&
    canCapture() &&
    navigator.doNotTrack !== "1" &&
    !(navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl &&
    localStorage.getItem("mcpjam-analytics-consent") !== "denied"
  );
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
    if (!allowed(canCapture)) return;
    const signal = AbortSignal.timeout(1200);
    const visits = await Promise.all(
      websiteOrigins.map((origin) => fromWebsite(origin, signal)),
    );
    if (!allowed(canCapture)) return;
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
