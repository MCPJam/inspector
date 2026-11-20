const NAME = "mcpjam_signup_campaign";

function currentCampaign(): string | undefined {
  if (location.hostname !== "app.mcpjam.com") return;
  const pair = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(NAME + "="));
  if (!pair) return;
  const label = decodeURIComponent(pair.slice(NAME.length + 1));
  if (/^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/.test(label))
    return label;
}

export function readSignupCampaign(): string | undefined {
  try {
    if (
      navigator.doNotTrack === "1" ||
      (navigator as Navigator & { globalPrivacyControl?: boolean })
        .globalPrivacyControl ||
      localStorage.getItem("mcpjam-analytics-consent") === "denied"
    )
      return;
    return currentCampaign();
  } catch {
    /* Unavailable storage must never interrupt sign-in. */
  }
}

export function clearSignupCampaign(acknowledged: string) {
  try {
    // Cleanup still applies when consent changed while the write was in flight.
    if (currentCampaign() !== acknowledged) return;
    document.cookie =
      NAME + "=; Domain=mcpjam.com; Path=/; Max-Age=0; Secure; SameSite=Lax";
  } catch {
    /* The short expiry also bounds cookie lifetime. */
  }
}
