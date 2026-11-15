/**
 * What a sign-in page asks for, read from what the browser daemon returns:
 * the page's address, its visible text (with any value the browser typed
 * already scrubbed back to its placeholder) and its controls by accessible
 * role and name. Pure, so every page a provider can show is a test fixture.
 *
 * The patterns are deliberately narrow. A page they do not recognize stops
 * the rehearsal for a person; a page they misread would type a password, or
 * approve access, where neither was asked for.
 */

export interface SignInControl {
  /** The daemon's ref for this control, valid until the next read. */
  ref: string;
  role: string;
  name: string;
}

export interface SignInPage {
  url: string;
  text: string;
  controls: SignInControl[];
}

export type SignInPageReading =
  /** Back at MCPJam's callback page, with whatever the redirect carried. */
  | { kind: "callback"; params: URLSearchParams }
  | { kind: "refused"; quote: string }
  | { kind: "verification"; quote: string }
  | { kind: "credentials"; username?: SignInControl; password?: SignInControl }
  /** `approve` is absent when no single control clearly approves. */
  | { kind: "consent"; approve?: SignInControl }
  | { kind: "unknown" };

const USERNAME = /\b(e-?mail|user ?name|login|account)\b/i;
const PASSWORD = /\bpass(word|phrase)\b/i;
/** A one-time password field is a verification step, not the password. */
const ONE_TIME = /\b(one[- ]time|otp|code|pin)\b/i;
const REFUSED =
  /\b(incorrect|invalid|wrong|unrecogni[sz]ed)\b.{0,40}\b(password|credentials|e-?mail|username)\b|\b(password|credentials)\b.{0,20}\b(incorrect|invalid|wrong)\b|\bcould(n.t| not) sign you in\b|\bno account (found|exists)\b|\baccount (is |has been )?(locked|disabled|suspended)\b/i;
const VERIFICATION =
  /\bverification code\b|\bone[- ]time (pass)?code\b|\benter the code\b|\bwe('ve| have)? sent (you )?an? (code|link|e-?mail)\b|\bmagic link\b|\bcheck your (e-?mail|inbox)\b|\btwo[- ]factor\b|\b2fa\b|\bmulti[- ]factor\b|\bauthenticator app\b|\bsecurity key\b|\bcaptcha\b|\bnot a robot\b|\bconfirm (it'?s|it is) you\b/i;
const CONSENT =
  /\b(wants|would like|is requesting) (to )?access\b|\ballow\b.{0,60}\baccess\b|\bauthori[sz]e\b.{0,60}\bto\b|\bgrant\b.{0,40}\baccess\b|\bconsent\b/i;
/** In the order a choice between several is made. */
const APPROVE_WORDS = [
  "allow",
  "authorize",
  "authorise",
  "approve",
  "accept",
  "grant",
  "continue",
];
const DENY = /^(deny|decline|reject|cancel|don.?t allow|no\b)/i;

const isTextbox = (control: SignInControl) =>
  control.role === "textbox" || control.role === "searchbox";

/** The line of `text` a pattern matched, cut to a quotable length. */
function quoteOf(text: string, pattern: RegExp): string {
  const line =
    text.split("\n").find((candidate) => pattern.test(candidate)) ?? text;
  // Its own closing punctuation goes: the sentence quoting it adds one.
  const quote = line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,]+$/, "");
  return quote.length > 300 ? `${quote.slice(0, 299)}…` : quote;
}

function approveControl(
  controls: SignInControl[],
  authKit: boolean,
): SignInControl | undefined {
  const buttons = controls.filter((control) => control.role === "button");
  const rank = (control: SignInControl) =>
    APPROVE_WORDS.findIndex((word) =>
      control.name.trim().toLowerCase().startsWith(word),
    );
  const approves = buttons
    .filter((control) => rank(control) >= 0)
    .sort((a, b) => rank(a) - rank(b));
  // AuthKit's consent page is known, so its first approve control is the one.
  // Elsewhere a click needs exactly one approve control beside a way to refuse.
  if (authKit) return approves[0];
  const offersRefusal = buttons.some((control) =>
    DENY.test(control.name.trim()),
  );
  return approves.length === 1 && offersRefusal ? approves[0] : undefined;
}

/** True for MCPJam's callback page, by origin and path, whatever the query. */
function isCallback(url: string, callbackUrl: string): boolean {
  try {
    const page = new URL(url);
    const callback = new URL(callbackUrl);
    return (
      page.origin === callback.origin && page.pathname === callback.pathname
    );
  } catch {
    // An unreadable address (`about:blank` mid-load) is not the callback.
    return false;
  }
}

/** AuthKit-hosted sign-in, the supported path; anything else is approximated. */
export function isAuthKitOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname.endsWith(".authkit.app");
  } catch {
    return false;
  }
}

export function readSignInPage(
  page: SignInPage,
  context: { callbackUrl: string; authKit: boolean; submitted: boolean },
): SignInPageReading {
  if (isCallback(page.url, context.callbackUrl)) {
    return { kind: "callback", params: new URL(page.url).searchParams };
  }
  // Only after something was submitted: before that, an error on the page is
  // not an answer to the reviewer's credentials.
  if (context.submitted && REFUSED.test(page.text)) {
    return { kind: "refused", quote: quoteOf(page.text, REFUSED) };
  }
  const textboxes = page.controls.filter(isTextbox);
  const password = textboxes.find(
    (control) => PASSWORD.test(control.name) && !ONE_TIME.test(control.name),
  );
  const username = textboxes.find(
    (control) => USERNAME.test(control.name) && control !== password,
  );
  if (username || password) return { kind: "credentials", username, password };
  if (VERIFICATION.test(page.text)) {
    return { kind: "verification", quote: quoteOf(page.text, VERIFICATION) };
  }
  if (CONSENT.test(page.text)) {
    return {
      kind: "consent",
      approve: approveControl(page.controls, context.authKit),
    };
  }
  return { kind: "unknown" };
}
