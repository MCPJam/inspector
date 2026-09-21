/**
 * Send the browser to GitHub, and nowhere else.
 *
 * The installation-binding flow is three redirects: we hand GitHub a state, it
 * hands us one back, and each leg is a URL the BACKEND built. That backend is
 * the only thing that knows the App slug, the OAuth client id, and the one-time
 * state — so the browser never assembles one of these, it only follows one.
 *
 * The allowlist below is therefore not defending against the backend. It is
 * defending against this function ever acquiring a second caller that passes
 * something less trustworthy: a `window.location.assign` with a string argument
 * is an open-redirect primitive, and the cheapest time to make it not be one is
 * before anybody needs it to be.
 *
 * Its own module for a duller reason too: `window.location` is famously
 * awkward to stub, and a component that calls it directly is a component whose
 * "did it send them to GitHub" test has to fight jsdom. Mocking one named
 * export is the whole job instead.
 */

/** The only origin a binding redirect may target. */
const GITHUB_ORIGIN = "https://github.com";

export class UnsafeRedirectError extends Error {
  constructor() {
    super("Refused to redirect outside GitHub");
    this.name = "UnsafeRedirectError";
  }
}

/**
 * Navigate to a github.com URL.
 *
 * Parsed rather than prefix-matched: `https://github.com.evil.test/` starts with
 * the right characters and is not GitHub, and a startsWith check is exactly how
 * that gets shipped. `URL.origin` is the comparison that means what it says.
 */
export function redirectToGithub(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeRedirectError();
  }
  if (parsed.origin !== GITHUB_ORIGIN) {
    throw new UnsafeRedirectError();
  }
  window.location.assign(parsed.toString());
}
