const NAME = "mcpjam_signup_campaign";

export function readSignupCampaign(): string | undefined {
  try {
    if (location.hostname !== "app.mcpjam.com" || navigator.doNotTrack === "1" ||
        (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl ||
        localStorage.getItem("mcpjam-analytics-consent") === "denied") return;
    const pair = document.cookie.split("; ").find(entry => entry.startsWith(NAME + "="));
    if (!pair) return;
    const label = decodeURIComponent(pair.slice(NAME.length + 1));
    if (/^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/.test(label)) return label;
  } catch { /* Unavailable storage must never interrupt sign-in. */ }
}

export function clearSignupCampaign() {
  try {
    document.cookie = NAME + "=; Domain=mcpjam.com; Path=/; Max-Age=0; Secure; SameSite=Lax";
  } catch { /* The short expiry also bounds cookie lifetime. */ }
}
