export function parseBearerAuthenticateParameters(
  header?: string,
): Record<string, string> {
  if (!header) {
    return {};
  }

  const match = header.trim().match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {};
  }

  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;

  for (let next = pattern.exec(match[1]); next; next = pattern.exec(match[1])) {
    params[next[1].toLowerCase()] = next[2] ?? next[3] ?? "";
  }

  return params;
}

export function parseScopeString(scopeValue?: string): string[] | undefined {
  if (!scopeValue) {
    return undefined;
  }

  const scopes = scopeValue
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes.length > 0 ? Array.from(new Set(scopes)) : undefined;
}

export function resolveRequestedScopeValue(input: {
  customScopes?: string;
  challengedScopes?: string[];
  supportedScopes?: string[];
}): string | undefined {
  const customScopes = input.customScopes?.trim();
  if (customScopes) {
    return customScopes;
  }

  const challengedScopes = input.challengedScopes?.filter(Boolean) ?? [];
  if (challengedScopes.length > 0) {
    return Array.from(new Set(challengedScopes)).join(" ");
  }

  const supportedScopes = input.supportedScopes?.filter(Boolean) ?? [];
  if (supportedScopes.length === 0) {
    return undefined;
  }

  return Array.from(new Set(supportedScopes)).join(" ");
}
