import type { BillingInterval } from "@/hooks/useOrganizationBilling";

export type CheckoutPlanTier = "starter" | "team";

export interface CheckoutIntent {
  plan: CheckoutPlanTier;
  interval: BillingInterval;
}

/** Plan + interval bound to the org route (for auto-checkout); not stored in sessionStorage. */
export type CheckoutIntentWithOrganization = CheckoutIntent & {
  organizationId: string;
};

const STORAGE_KEY = "mcpjam:checkout-intent";
const SIGN_IN_RETURN_PATH_STORAGE_KEY = "mcpjam:billing-signin-return-path";

const VALID_PLANS = new Set<CheckoutPlanTier>(["starter", "team"]);
const VALID_INTERVALS = new Set<BillingInterval>(["monthly", "annual"]);

function parseSearchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
}

function isValidPlan(value: string | null): value is CheckoutPlanTier {
  return value !== null && VALID_PLANS.has(value as CheckoutPlanTier);
}

function isValidInterval(value: string | null): value is BillingInterval {
  return value !== null && VALID_INTERVALS.has(value as BillingInterval);
}

/**
 * True when `plan` appears in the query with a non-starter/team value (or empty).
 */
export function hasInvalidCheckoutQueryParams(search: string): boolean {
  const params = parseSearchParams(search);
  if (!params.has("plan")) {
    return false;
  }
  const raw = params.get("plan");
  if (raw === null || raw.trim() === "") {
    return true;
  }
  return !isValidPlan(raw);
}

export function hasInvalidCheckoutIntervalParam(search: string): boolean {
  const params = parseSearchParams(search);
  if (!params.has("interval")) {
    return false;
  }
  const raw = params.get("interval");
  if (raw === null || raw.trim() === "") {
    return true;
  }
  return !isValidInterval(raw);
}

/**
 * Read validated checkout intent from a query string (e.g. `window.location.search`).
 */
export function readCheckoutIntentFromSearch(
  search: string,
): CheckoutIntent | null {
  const params = parseSearchParams(search);
  const planRaw = params.get("plan");
  const intervalRaw = params.get("interval");

  if (!isValidPlan(planRaw)) {
    return null;
  }

  if (params.has("interval")) {
    if (!isValidInterval(intervalRaw)) {
      return null;
    }
    return { plan: planRaw, interval: intervalRaw };
  }

  const interval: BillingInterval = "monthly";
  return { plan: planRaw, interval };
}

/**
 * Read checkout intent from the current window location (browser only).
 */
export function readCheckoutIntent(): CheckoutIntent | null {
  if (typeof window === "undefined") {
    return null;
  }
  return readCheckoutIntentFromSearch(window.location.search);
}

/**
 * Remove `plan` and `interval` from the URL without reloading.
 */
export function clearCheckoutIntentFromUrl(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  let changed = false;
  if (url.searchParams.has("plan")) {
    url.searchParams.delete("plan");
    changed = true;
  }
  if (url.searchParams.has("interval")) {
    url.searchParams.delete("interval");
    changed = true;
  }
  if (changed) {
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
}

export function persistCheckoutIntent(intent: CheckoutIntent): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ plan: intent.plan, interval: intent.interval }),
    );
  } catch {
    // ignore quota / private mode
  }
}

export function readPersistedCheckoutIntent(): CheckoutIntent | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("plan" in parsed) ||
      !("interval" in parsed)
    ) {
      return null;
    }
    const plan = (parsed as { plan: unknown }).plan;
    const interval = (parsed as { interval: unknown }).interval;
    if (!isValidPlan(typeof plan === "string" ? plan : null)) {
      return null;
    }
    if (!isValidInterval(typeof interval === "string" ? interval : null)) {
      return null;
    }
    return { plan, interval };
  } catch {
    return null;
  }
}

export function clearPersistedCheckoutIntent(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function writeBillingSignInReturnPath(path: string): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  const normalizedPath = path.trim();
  if (!isBillingEntryPathname(normalizedPath)) {
    return;
  }

  try {
    sessionStorage.setItem(SIGN_IN_RETURN_PATH_STORAGE_KEY, normalizedPath);
  } catch {
    // ignore quota / private mode
  }
}

export function readBillingSignInReturnPath(): string | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const normalizedPath = raw.trim();
    if (!isBillingEntryPathname(normalizedPath)) {
      return null;
    }

    return normalizedPath;
  } catch {
    return null;
  }
}

export function clearBillingSignInReturnPath(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(SIGN_IN_RETURN_PATH_STORAGE_KEY);
  } catch {
    // ignore quota / private mode
  }
}

/** Strip URL params and clear session storage in one step. */
export function clearCheckoutIntent(): void {
  clearCheckoutIntentFromUrl();
  clearPersistedCheckoutIntent();
}

export function isBillingEntryPathname(pathname: string): boolean {
  return pathname === "/billing" || pathname === "/billing/";
}

export function hashMatchesOrganizationBilling(
  hash: string,
  organizationId: string,
): boolean {
  const parts = hash
    .replace(/^#/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  return (
    parts[0] === "organizations" &&
    parts[1] === organizationId &&
    parts[2] === "billing"
  );
}

export function resolveCheckoutOrganizationId(
  sortedOrganizations: readonly { _id: string }[],
  activeOrganizationId: string | undefined,
  workspaceOrganizationId: string | undefined,
): string | null {
  if (sortedOrganizations.length === 0) {
    return null;
  }
  if (sortedOrganizations.length === 1) {
    return sortedOrganizations[0]._id;
  }
  const ids = new Set(sortedOrganizations.map((o) => o._id));
  if (activeOrganizationId && ids.has(activeOrganizationId)) {
    return activeOrganizationId;
  }
  if (workspaceOrganizationId && ids.has(workspaceOrganizationId)) {
    return workspaceOrganizationId;
  }
  return sortedOrganizations[0]._id;
}
