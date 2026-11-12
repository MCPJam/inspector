const KEY = "mcpjam_promo_intent";
const TTL = 30 * 60 * 1000;
// A code belongs to the campaign whose link carried it, so opening another
// campaign in the same tab never offers the previous campaign's code.
type Intent = { code: string; storedAt: number; campaign: string };
let memory: Intent | null | undefined;

const CAMPAIGN_KEY = /^[a-z0-9-]{1,80}$/;
/** Printed AGNTCon cards link to `/redeem` with no campaign. */
export const DEFAULT_PROMO_CAMPAIGN = "agntcon-2026";

function campaignOrNull(value: unknown) {
  return typeof value === "string" && CAMPAIGN_KEY.test(value) ? value : null;
}

/** The campaign key is printed in a shared QR, so it may live in the URL. */
export function readPromoCampaign(search = window.location.search) {
  return (
    campaignOrNull(new URLSearchParams(search).get("campaign")) ??
    DEFAULT_PROMO_CAMPAIGN
  );
}

export function clearPromoIntent() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
    return true;
  } catch {
    // Memory is cleared; callers must retain recovery state if storage stays stale.
    console.debug("Promo intent storage unavailable");
    return false;
  }
}

export function savePromoIntent(
  code: string,
  now = Date.now(),
  campaign = readPromoCampaign(),
) {
  memory = { code, storedAt: now, campaign };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
    return true;
  } catch {
    // The form can use memory, but a sign-in redirect will require manual entry.
    console.debug("Promo intent storage unavailable");
    return false;
  }
}

export function readPromoIntent(
  now = Date.now(),
  campaign = readPromoCampaign(),
): string {
  try {
    if (memory === undefined) {
      const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      if (
        raw &&
        typeof raw === "object" &&
        "code" in raw &&
        "storedAt" in raw &&
        typeof raw.code === "string" &&
        raw.code.length <= 64 &&
        typeof raw.storedAt === "number"
      ) {
        memory = {
          code: raw.code,
          storedAt: raw.storedAt,
          campaign:
            ("campaign" in raw && campaignOrNull(raw.campaign)) ||
            DEFAULT_PROMO_CAMPAIGN,
        };
      }
    }
  } catch {
    // A blocked or malformed store falls back to the current page's memory.
    console.debug("Promo intent storage unavailable");
  }
  if (!memory || now < memory.storedAt || now - memory.storedAt >= TTL) {
    clearPromoIntent();
    return "";
  }
  return memory.campaign === campaign ? memory.code : "";
}

export function redeemPath(campaign: string | null, manual = false) {
  const params = new URLSearchParams();
  if (manual) params.set("manual", "1");
  if (campaign && campaign !== DEFAULT_PROMO_CAMPAIGN)
    params.set("campaign", campaign);
  const query = params.toString();
  return query ? `/redeem?${query}` : "/redeem";
}

/**
 * Only non-secret values cross the authentication redirect: the recovery flag
 * and the public campaign key, so a lost intent still lands on its campaign.
 */
export function promoSignInState(campaign: string) {
  const code = readPromoIntent(Date.now(), campaign);
  let stored = false;
  try {
    stored = sessionStorage.getItem(KEY) === JSON.stringify(memory);
  } catch {
    // Authentication can continue with manual entry when storage is blocked.
    console.debug("Promo intent storage unavailable");
  }
  return {
    promoReturn: true,
    promoManualEntry: !code || !stored,
    promoCampaign: campaign,
  };
}

export function promoSignInReturn(state: Record<string, unknown> | null) {
  if (state?.promoReturn !== true) return null;
  return redeemPath(
    campaignOrNull(state.promoCampaign),
    state.promoManualEntry === true,
  );
}

/** Capture before app-bootstrap initializes telemetry or sign-in return state. */
export function capturePromoIntent() {
  if (window.location.pathname.replace(/\/+$/, "") !== "/redeem") return;
  const url = new URL(window.location.href);
  const campaign = campaignOrNull(url.searchParams.get("campaign"));
  if (url.searchParams.get("manual") === "1") {
    if (clearPromoIntent()) {
      window.history.replaceState(
        window.history.state,
        "",
        redeemPath(campaign),
      );
    }
    return;
  }
  const code =
    url.searchParams.get("code") ??
    new URLSearchParams(url.hash.slice(1)).get("code");
  if (code !== null) {
    if (code.length <= 64)
      savePromoIntent(code, Date.now(), campaign ?? DEFAULT_PROMO_CAMPAIGN);
    else clearPromoIntent();
    window.history.replaceState(window.history.state, "", redeemPath(campaign));
  }
}

export function watchPromoIntent() {
  const capture = () => {
    capturePromoIntent();
    window.dispatchEvent(new Event("promo-intent-changed"));
  };
  window.addEventListener("hashchange", capture);
  window.addEventListener("popstate", capture);
}
