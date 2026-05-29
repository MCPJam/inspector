import { normalizeReturnTargetPath, routePaths } from "./app-navigation";

const CLI_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_cli_signin_return_path_v1";

function normalizeCliReturnPath(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed || trimmed === routePaths.root || trimmed.startsWith("/?")) {
    return routePaths.root;
  }
  return normalizeReturnTargetPath(trimmed, routePaths.root);
}

export function writeCliSignInReturnPath(path: string | null | undefined): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  const normalizedPath = normalizeCliReturnPath(path);
  try {
    sessionStorage.setItem(
      CLI_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readCliSignInReturnPath(): string | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(CLI_SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) return null;
    return normalizeCliReturnPath(raw);
  } catch {
    return null;
  }
}

export function clearCliSignInReturnPath(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(CLI_SIGN_IN_RETURN_PATH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
