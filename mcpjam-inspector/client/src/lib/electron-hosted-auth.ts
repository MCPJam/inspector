export const ELECTRON_HOSTED_AUTH_STATE_KEY =
  "__mcpjam_electron_hosted_auth";

type AuthCallbackLocation = Pick<
  Location,
  "origin" | "pathname" | "protocol" | "search"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createElectronHostedAuthState(
  state?: unknown,
): Record<string, unknown> {
  if (isRecord(state)) {
    return {
      ...state,
      [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
    };
  }

  if (state === undefined) {
    return {
      [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
    };
  }

  return {
    [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
    originalState: state,
  };
}

export function parseElectronHostedAuthState(
  rawState: string | null,
): Record<string, unknown> | null {
  if (!rawState) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawState);
    if (
      isRecord(parsed) &&
      parsed[ELECTRON_HOSTED_AUTH_STATE_KEY] === true
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed state values.
  }

  return null;
}

export function isElectronHostedAuthCallback(
  location: Pick<Location, "pathname" | "search">,
): boolean {
  if (location.pathname !== "/callback") {
    return false;
  }

  const params = new URLSearchParams(location.search);
  if (!params.get("code") && !params.get("error")) {
    return false;
  }

  return parseElectronHostedAuthState(params.get("state")) !== null;
}

export function buildElectronHostedAuthCallbackUrl(
  location: Pick<Location, "pathname" | "search">,
): string | null {
  if (!isElectronHostedAuthCallback(location)) {
    return null;
  }

  const callbackUrl = new URL("mcpjam://oauth/callback");
  const params = new URLSearchParams(location.search);

  for (const [key, value] of params.entries()) {
    callbackUrl.searchParams.append(key, value);
  }

  return callbackUrl.toString();
}

export function resolveWorkosRedirectUri(options: {
  envRedirect?: string;
  isElectron: boolean;
  location: AuthCallbackLocation;
}): string {
  const { envRedirect, isElectron, location } = options;
  const isBrowserHttp =
    location.protocol === "http:" || location.protocol === "https:";

  if (isElectron) {
    return isBrowserHttp
      ? `${location.origin}/callback`
      : envRedirect ?? "mcpjam://oauth/callback";
  }

  if (isBrowserHttp) {
    return `${location.origin}/callback`;
  }

  return envRedirect ?? `${location.origin}/callback`;
}
