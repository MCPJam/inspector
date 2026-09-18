import { HOSTED_MODE } from "./config";
import { scrubSensitiveUrl } from "./PosthogUtils";

/**
 * Google tag (gtag.js) for the hosted app.
 *
 * The marketing site (mcpjam.com) already runs GA4 and the Google Ads tag, but
 * every signup happens here on app.mcpjam.com, where nothing Google-side runs.
 * That leaves ad attribution blind past the landing page: an ad click lands on
 * the marketing site, the visitor crosses to the app, signs up, and neither GA4
 * nor Google Ads ever sees the conversion. Loading the same tag here is what
 * lets GA4 cross-domain measurement stitch the two sites into one session and
 * lets a `sign_up` event later be imported into Google Ads as a conversion.
 *
 * Hosted only, on purpose. npx/Docker installs run on someone else's machine
 * and must not report to our Google properties, and the packaged desktop app
 * has no ad landing page to attribute to. Mirrors `isErrorCaptureSurface` in
 * PosthogUtils, minus the desktop case.
 *
 * Off by default: `VITE_GOOGLE_TAG_IDS` (comma-separated, e.g.
 * `G-XXXXXXX,AW-XXXXXXXXX`) is read at build time and an empty value loads
 * nothing, so PR previews and staging stay out of production analytics unless
 * an operator opts them in.
 */

/** Parse the comma-separated build-time id list. Whitespace-tolerant. */
export function parseGoogleTagIds(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^(G|AW|GT|DC|UA)-[A-Z0-9-]+$/i.test(id));
}

export const GOOGLE_TAG_IDS: readonly string[] = parseGoogleTagIds(
  import.meta.env.VITE_GOOGLE_TAG_IDS as string | undefined,
);

export const GOOGLE_TAG_SCRIPT_BASE =
  "https://www.googletagmanager.com/gtag/js";

type GtagWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  isElectron?: boolean;
};

export type LoadGoogleTagOptions = {
  ids?: readonly string[];
  hostedMode?: boolean;
  win?: GtagWindow;
  doc?: Document;
};

/**
 * Whether this page load should carry the Google tag at all.
 *
 * Exported so the decision is unit-testable without touching the DOM.
 */
export function shouldLoadGoogleTag({
  ids = GOOGLE_TAG_IDS,
  hostedMode = HOSTED_MODE,
  win = typeof window === "undefined" ? undefined : (window as GtagWindow),
}: Pick<LoadGoogleTagOptions, "ids" | "hostedMode" | "win"> = {}): boolean {
  if (ids.length === 0) return false;
  if (!hostedMode) return false;
  if (!win) return false;
  // The desktop app renders the hosted bundle inside Electron; a Google tag
  // there would attribute nothing and leak desktop usage into web analytics.
  if (win.isElectron === true) return false;
  return true;
}

/**
 * Inject gtag.js once and configure every id.
 *
 * Idempotent: a second call finds the script already in the document and
 * only returns. The page location handed to GA4 is the same scrubbed URL
 * PostHog sees (`scrubSensitiveUrl`), so a bearer-token share path such as
 * `/results/<token>` never reaches Google as a `page_location`.
 *
 * Returns whether the tag was (or already had been) loaded.
 */
export function loadGoogleTag({
  ids = GOOGLE_TAG_IDS,
  hostedMode = HOSTED_MODE,
  win = typeof window === "undefined" ? undefined : (window as GtagWindow),
  doc = typeof document === "undefined" ? undefined : document,
}: LoadGoogleTagOptions = {}): boolean {
  if (!shouldLoadGoogleTag({ ids, hostedMode, win }) || !win || !doc) {
    return false;
  }

  const primaryId = ids[0];
  const scriptSrc = `${GOOGLE_TAG_SCRIPT_BASE}?id=${encodeURIComponent(
    primaryId,
  )}`;
  if (doc.querySelector(`script[src="${scriptSrc}"]`)) {
    return true;
  }

  // The standard gtag bootstrap: a `dataLayer` queue the async script drains
  // once it arrives, and a `gtag` stub that pushes onto it. gtag.js reads the
  // pushed entries as `arguments` objects, not arrays, so the stub must use
  // `arguments` rather than a rest parameter.
  win.dataLayer = win.dataLayer ?? [];
  const dataLayer = win.dataLayer;
  win.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  };

  win.gtag("js", new Date());
  const pageLocation = scrubSensitiveUrl(win.location.href);
  for (const id of ids) {
    win.gtag("config", id, { page_location: pageLocation });
  }

  const script = doc.createElement("script");
  script.src = scriptSrc;
  script.async = true;
  script.addEventListener(
    "error",
    () => {
      // Ad blockers are the common cause. Analytics is best-effort: keep the
      // failure observable and move on, exactly as the PostHog path does.
      console.warn("[google-tag] gtag.js failed to load");
    },
    { once: true },
  );
  doc.head.appendChild(script);
  return true;
}

export const GOOGLE_SIGN_UP_EVENT = "sign_up";

/** Storage key that remembers a `sign_up` already sent for this account. */
export function googleSignUpSentKey(userId: string): string {
  return `mcpjam.google-tag.sign-up.${userId}`;
}

export type TrackGoogleSignUpOptions = {
  /** The account the signup created or promoted; dedupes repeat fires. */
  userId: string;
  /** GA4's standard `method` parameter for `sign_up`. */
  method: "workos" | "guest_promotion";
  win?: GtagWindow;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

/**
 * Report a completed signup to the Google tag as GA4's recommended `sign_up`
 * event, which is what the Ads account imports as a conversion.
 *
 * No-op unless the tag is on the page (`window.gtag` is only ever set by
 * `loadGoogleTag`, so every surface that never loads the tag never fires
 * this either). Fires at most once per account per browser: the user
 * bootstrap that reports the signup can legitimately run more than once for
 * the same identity (StrictMode, a recovery retry, a second hook instance),
 * and Google would count each as a conversion.
 *
 * Returns whether the event was sent.
 */
export function trackGoogleSignUp({
  userId,
  method,
  win = typeof window === "undefined" ? undefined : (window as GtagWindow),
  storage = typeof window === "undefined" ? null : safeSessionStorage(),
}: TrackGoogleSignUpOptions): boolean {
  if (!win || typeof win.gtag !== "function") return false;
  const key = googleSignUpSentKey(userId);
  try {
    if (storage?.getItem(key)) return false;
  } catch {
    // Storage denied (private mode, blocked site data): fall through and
    // send once; without a marker a later re-run may repeat it, which is
    // the lesser evil next to never counting the signup.
  }
  try {
    win.gtag("event", GOOGLE_SIGN_UP_EVENT, { method });
  } catch (error) {
    console.warn("[google-tag] sign_up event failed", error);
    return false;
  }
  try {
    storage?.setItem(key, String(Date.now()));
  } catch {
    // Same as above: the event went out; only the dedupe marker is lost.
  }
  return true;
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
