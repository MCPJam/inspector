export const MCPJAM_HOSTED_APP_ORIGIN = "https://app.mcpjam.com";

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      /^[a-z0-9.-]+$|^\[[a-f0-9:]+\]$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export function signupCampaignWebsiteOrigins(
  appOrigin: string,
  config?: {
    signupCampaignAppOrigin?: string;
    signupCampaignWebsiteOrigins?: string;
  } | null,
): string[] {
  if (appOrigin === MCPJAM_HOSTED_APP_ORIGIN)
    return ["https://www.mcpjam.com", "https://mcpjam.com"];
  if (
    appOrigin !== config?.signupCampaignAppOrigin ||
    !exactHttpsOrigin(appOrigin)
  )
    return [];
  return (config.signupCampaignWebsiteOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(exactHttpsOrigin);
}
