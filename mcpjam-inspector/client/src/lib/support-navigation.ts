const SUPPORT_CONTACT_URL = "https://www.mcpjam.com/contact";

/**
 * Send the browser to the support contact page.
 *
 * Its own module so a test can assert the navigation by mocking one export
 * instead of stubbing `window.location`, the same reason
 * `github-external-redirect.ts` is separate.
 */
export function navigateToSupport(): void {
  window.location.href = SUPPORT_CONTACT_URL;
}
