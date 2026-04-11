export function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSensitiveString(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedactKey(key)
        ? "[REDACTED]"
        : redactSensitiveValue(entryValue),
    ]),
  );
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
      (_match, headerName: string) => `${headerName}: [REDACTED]`,
    )
    .replace(
      /\bBearer\s+(?![A-Za-z_][A-Za-z0-9_-]*=)([A-Za-z0-9\-._~+/]+=*)/giu,
      "Bearer [REDACTED]",
    )
    .replace(
      /\b(access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier)=([^&\s]+)/giu,
      "$1=[REDACTED]",
    )
    .replace(
      /(["']?(?:access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier)["']?\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    );
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");

  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "clientsecret" ||
    normalized === "idtoken" ||
    normalized === "apikey" ||
    normalized === "xapikey"
  );
}
