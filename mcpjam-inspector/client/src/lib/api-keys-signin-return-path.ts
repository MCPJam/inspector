import { normalizeReturnTargetPath, routePaths } from "./app-navigation";

/**
 * Sign-in return path for the `/settings/api-keys` surface.
 *
 * The docs deep-link signed-out readers straight to the API keys page;
 * persisting the path across the AuthKit redirect lands them back on key
 * management instead of the app root after they sign in. Same pattern as
 * the chatbox/billing/CLI return paths consumed by the `/callback` handler
 * in `App.tsx`.
 */

const API_KEYS_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_api_keys_signin_return_path_v1";

function normalizeApiKeysReturnPath(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed || trimmed === routePaths.root || trimmed.startsWith("/?")) {
    return routePaths.root;
  }
  return normalizeReturnTargetPath(trimmed, routePaths.root);
}

export function writeApiKeysSignInReturnPath(
  path: string | null | undefined
): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  const normalizedPath = normalizeApiKeysReturnPath(path);
  try {
    sessionStorage.setItem(
      API_KEYS_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readApiKeysSignInReturnPath(): string | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(
      API_KEYS_SIGN_IN_RETURN_PATH_STORAGE_KEY
    );
    if (!raw) return null;
    return normalizeApiKeysReturnPath(raw);
  } catch {
    return null;
  }
}

export function clearApiKeysSignInReturnPath(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(API_KEYS_SIGN_IN_RETURN_PATH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
