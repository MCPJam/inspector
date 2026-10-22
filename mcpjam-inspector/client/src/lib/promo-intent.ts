const KEY = "mcpjam_promo_intent";
const TTL = 30 * 60 * 1000;
type Intent = { code: string; storedAt: number };
let memory: Intent | null | undefined;

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

export function savePromoIntent(code: string, now = Date.now()) {
  memory = { code, storedAt: now };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
    return true;
  } catch {
    // The form can use memory, but a sign-in redirect will require manual entry.
    console.debug("Promo intent storage unavailable");
    return false;
  }
}

export function readPromoIntent(now = Date.now()): string {
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
        memory = { code: raw.code, storedAt: raw.storedAt };
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
  return memory.code;
}

/** Only a non-secret recovery flag crosses the authentication redirect. */
export function promoSignInState() {
  const code = readPromoIntent();
  let stored = false;
  try {
    stored = sessionStorage.getItem(KEY) === JSON.stringify(memory);
  } catch {
    // Authentication can continue with manual entry when storage is blocked.
    console.debug("Promo intent storage unavailable");
  }
  return { promoReturn: true, promoManualEntry: !code || !stored };
}

export function promoSignInReturn(state: Record<string, unknown> | null) {
  if (state?.promoReturn !== true) return null;
  return state.promoManualEntry === true ? "/redeem?manual=1" : "/redeem";
}

/** Capture before app-bootstrap initializes telemetry or sign-in return state. */
export function capturePromoIntent() {
  if (window.location.pathname.replace(/\/+$/, "") !== "/redeem") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("manual") === "1") {
    if (clearPromoIntent()) {
      window.history.replaceState(window.history.state, "", "/redeem");
    }
    return;
  }
  const code =
    url.searchParams.get("code") ??
    new URLSearchParams(url.hash.slice(1)).get("code");
  if (code !== null) {
    if (code.length <= 64) savePromoIntent(code);
    else clearPromoIntent();
    window.history.replaceState(window.history.state, "", "/redeem");
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
