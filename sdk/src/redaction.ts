export function redactSensitiveValue(value: unknown): unknown {
  return redactSensitiveValueAtPath(value, []);
}

function redactSensitiveValueAtPath(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValueAtPath(entry, path));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSensitiveString(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedactKey(key, entryValue, path)
        ? "[REDACTED]"
        : redactSensitiveValueAtPath(entryValue, [...path, key]),
    ])
  );
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
      (_match, headerName: string) => `${headerName}: [REDACTED]`
    )
    .replace(
      /\bBearer\s+(?![A-Za-z_][A-Za-z0-9_-]*=)([A-Za-z0-9\-._~+/]+=*)/giu,
      "Bearer [REDACTED]"
    )
    .replace(
      /\b(access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier)=([^&\s]+)/giu,
      "$1=[REDACTED]"
    )
    .replace(
      /(["']?(?:access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier)["']?\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2"
    );
}

function shouldRedactKey(key: string, value: unknown, path: string[]): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");

  if (normalized === "code") {
    return shouldRedactAuthorizationCodeValue(value, path);
  }

  if (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie"
  ) {
    return true;
  }

  return (
    ((normalized === "codeverifier" ||
      normalized === "accesstoken" ||
      normalized.endsWith("accesstoken") ||
      normalized === "refreshtoken" ||
      normalized.endsWith("refreshtoken") ||
      normalized === "clientsecret" ||
      normalized.endsWith("clientsecret") ||
      normalized === "idtoken" ||
      normalized.endsWith("idtoken")) &&
      shouldRedactSecretValue(value)) ||
    normalized === "apikey" ||
    normalized === "xapikey"
  );
}

function shouldRedactSecretValue(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function shouldRedactAuthorizationCodeValue(
  value: unknown,
  path: string[]
): boolean {
  if (
    path[path.length - 1] === "error" ||
    path[path.length - 1] === "snapshotError"
  ) {
    return false;
  }

  if (typeof value !== "string") {
    return false;
  }

  if (/^[A-Z0-9_:-]+$/u.test(value)) {
    return false;
  }

  return value.length > 0;
}
