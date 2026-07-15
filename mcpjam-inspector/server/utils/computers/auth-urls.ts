/**
 * Auth-URL detection for computer command output.
 *
 * CLI logins inside the sandbox are device-flow only (no OAuth callback
 * tunneling in MVP — see docs/project-computers.md in mcpjam-backend), so
 * tools like `gh auth login` and `gcloud auth login --no-launch-browser`
 * print a verification URL the user must open in their own browser. We
 * surface those URLs as a structured field on the bash tool result so the
 * client can render them as clickable links instead of burying them in a
 * terminal scrollback.
 *
 * Detection is deliberately conservative: an https URL is only "an auth URL"
 * when its host or path matches a known device-flow / login pattern. False
 * negatives are cheap (the URL is still in stdout); false positives would
 * train users to click random links the model printed.
 */

const URL_PATTERN = /https:\/\/[^\s<>"'`)\]]+/g;

const AUTH_URL_MATCHERS: RegExp[] = [
  /github\.com\/login\/device/i,
  /(?:^|\.)google\.com\/device/i,
  /accounts\.google\.com/i,
  /login\.microsoftonline\.com/i,
  /microsoft\.com\/devicelogin/i,
  /\/(?:device|activate|verify|login|oauth|authorize|auth)(?:\/|\?|$)/i,
];

/** Extract deduped auth-looking URLs from command output (order preserved). */
export function detectAuthUrls(output: string): string[] {
  const seen = new Set<string>();
  const matches = output.match(URL_PATTERN) ?? [];
  for (const raw of matches) {
    // Strip common trailing punctuation that regexes drag in from prose.
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    if (AUTH_URL_MATCHERS.some((matcher) => matcher.test(url))) {
      seen.add(url);
    }
  }
  return [...seen];
}
