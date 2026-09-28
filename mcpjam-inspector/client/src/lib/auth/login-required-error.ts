/**
 * The message authkit fixes on `LoginRequiredError`
 * (`readonly message = "No access token available"`), so it is identical for
 * every throw site.
 */
export const LOGIN_REQUIRED_ERROR_MESSAGE = "No access token available";

/**
 * Is this failure authkit's `LoginRequiredError` — i.e. WorkOS has no session
 * left, so there is nothing a retry could refresh?
 *
 * Both of the obvious identity checks are unusable here:
 *
 * - `instanceof` — authkit-react bundles its own copy of the error class, so
 *   the constructor we could import is not the one the throw site used.
 * - `error.name` — authkit declares `class LoginRequiredError extends
 *   AuthKitError` and never assigns `name`, so every instance inherits
 *   `"Error"` from `Error.prototype`. `constructor.name` is no better: the
 *   production bundle mangles it.
 *
 * The message is the one marker that survives both, so that is what we match.
 * `name` is still accepted in case a later authkit sets it.
 */
export function isLoginRequiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "LoginRequiredError" ||
    error.message.includes(LOGIN_REQUIRED_ERROR_MESSAGE)
  );
}
