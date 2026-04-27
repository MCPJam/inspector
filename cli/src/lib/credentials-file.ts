import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveValue } from "./redaction.js";
import { operationalError, usageError } from "./output.js";

const CREDENTIALS_FILE_VERSION = 1;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface CredentialsFileContents {
  version: 1;
  serverUrl: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenType?: string;
  expiresAt?: string;
  protocolVersion?: string;
}

export interface CredentialsFileSource {
  serverUrl: string;
  protocolVersion?: string;
  credentials?: {
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenType?: string;
    expiresIn?: number;
  };
}

export type CredentialsFileAuth =
  | {
      accessToken: string;
      refreshToken?: never;
      clientId?: never;
      clientSecret?: never;
    }
  | {
      accessToken?: never;
      refreshToken: string;
      clientId: string;
      clientSecret?: string;
    };

export async function writeCredentialsFile(
  outputPath: string,
  result: CredentialsFileSource,
  now = new Date(),
): Promise<string> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  const contents = validateCredentialsFileContents(
    { ...buildCredentialsFileContents(result, now) },
    resolvedPath,
  );
  const outputDirectory = path.dirname(resolvedPath);
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(resolvedPath)}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      temporaryPath,
      `${JSON.stringify(contents, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, resolvedPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw operationalError(
      `Failed to write credentials file to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return resolvedPath;
}

export function readCredentialsFile(filePath: string): CredentialsFileContents {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw usageError(
      `Cannot read credentials file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usageError(`Credentials file "${filePath}" is not valid JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("Credentials file must be a JSON object");
  }

  return validateCredentialsFileContents(
    parsed as Record<string, unknown>,
    filePath,
  );
}

export function resolveCredentialsFileAuth(
  filePath: string,
  serverUrl: string,
  now = new Date(),
): CredentialsFileAuth {
  const contents = readCredentialsFile(filePath);
  assertMatchingServerUrl(contents.serverUrl, serverUrl, filePath);

  if (contents.accessToken && isAccessTokenUsable(contents, now)) {
    return { accessToken: contents.accessToken };
  }

  if (contents.refreshToken && contents.clientId) {
    return {
      refreshToken: contents.refreshToken,
      clientId: contents.clientId,
      ...(contents.clientSecret ? { clientSecret: contents.clientSecret } : {}),
    };
  }

  if (contents.accessToken) {
    throw usageError(
      `Credentials file "${filePath}" has an expired access token and no refresh token credentials.`,
    );
  }

  throw usageError(`Credentials file "${filePath}" does not contain usable OAuth credentials.`);
}

export function resolveCredentialsFileAccessToken(
  filePath: string,
  serverUrl: string,
  now = new Date(),
): string {
  const contents = readCredentialsFile(filePath);
  assertMatchingServerUrl(contents.serverUrl, serverUrl, filePath);

  if (contents.accessToken && isAccessTokenUsable(contents, now)) {
    return contents.accessToken;
  }

  throw usageError(
    `Credentials file "${filePath}" does not contain a non-expired access token for this command.`,
  );
}

export function assertNoCredentialsFileAuthConflicts(
  options: {
    credentialsFile?: string;
    accessToken?: string;
    oauthAccessToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  },
): void {
  if (
    !options.credentialsFile ||
    !(
      options.accessToken?.trim() ||
      options.oauthAccessToken?.trim() ||
      options.refreshToken?.trim() ||
      options.clientId?.trim() ||
      options.clientSecret?.trim()
    )
  ) {
    return;
  }

  throw usageError(
    "--credentials-file cannot be used together with --access-token, --oauth-access-token, --refresh-token, --client-id, or --client-secret.",
  );
}

export function redactCredentialsFromResult(
  result: CredentialsFileSource,
  credentialsFilePath?: string,
): object {
  const redacted = redactSensitiveValue(result) as Record<string, unknown>;
  const credentials = result.credentials ?? {};
  const hasCredentials = Object.keys(credentials).length > 0;
  const secretMarker = credentialsFilePath ? "[SAVED_TO_FILE]" : "[REDACTED]";
  const redactedCredentials = {
    ...((redacted.credentials ?? {}) as Record<string, unknown>),
    ...(credentials.clientId ? { clientId: credentials.clientId } : {}),
    ...(credentials.tokenType ? { tokenType: credentials.tokenType } : {}),
    ...(credentials.expiresIn !== undefined
      ? { expiresIn: credentials.expiresIn }
      : {}),
    ...(credentials.accessToken ? { accessToken: secretMarker } : {}),
    ...(credentials.refreshToken ? { refreshToken: secretMarker } : {}),
    ...(credentials.clientSecret ? { clientSecret: secretMarker } : {}),
  };

  return {
    ...redacted,
    ...(hasCredentials ? { credentials: redactedCredentials } : {}),
    ...(credentialsFilePath ? { credentialsFile: credentialsFilePath } : {}),
  };
}

export function hasCredentialsToSave(result: CredentialsFileSource): boolean {
  return Boolean(
    result.credentials?.accessToken || result.credentials?.refreshToken,
  );
}

function buildCredentialsFileContents(
  result: CredentialsFileSource,
  now: Date,
): CredentialsFileContents {
  if (!hasCredentialsToSave(result)) {
    throw usageError("OAuth flow did not return usable credentials to save.");
  }

  const credentials = result.credentials ?? {};
  const expiresAt =
    typeof credentials.expiresIn === "number" &&
    Number.isFinite(credentials.expiresIn)
      ? new Date(now.getTime() + credentials.expiresIn * 1000).toISOString()
      : undefined;

  return {
    version: CREDENTIALS_FILE_VERSION,
    serverUrl: result.serverUrl,
    ...(credentials.accessToken
      ? { accessToken: credentials.accessToken }
      : {}),
    ...(credentials.refreshToken
      ? { refreshToken: credentials.refreshToken }
      : {}),
    ...(credentials.clientId ? { clientId: credentials.clientId } : {}),
    ...(credentials.clientSecret
      ? { clientSecret: credentials.clientSecret }
      : {}),
    ...(credentials.tokenType
      ? { tokenType: credentials.tokenType }
      : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(result.protocolVersion ? { protocolVersion: result.protocolVersion } : {}),
  };
}

function validateCredentialsFileContents(
  value: Record<string, unknown>,
  filePath: string,
): CredentialsFileContents {
  if (value.version !== CREDENTIALS_FILE_VERSION) {
    throw usageError(
      `Unsupported credentials file version "${String(value.version)}".`,
    );
  }

  const contents: CredentialsFileContents = {
    version: CREDENTIALS_FILE_VERSION,
    serverUrl: requireString(value.serverUrl, "serverUrl"),
    ...optionalStringField(value, "accessToken"),
    ...optionalStringField(value, "refreshToken"),
    ...optionalStringField(value, "clientId"),
    ...optionalStringField(value, "clientSecret"),
    ...optionalStringField(value, "tokenType"),
    ...optionalStringField(value, "expiresAt"),
    ...optionalStringField(value, "protocolVersion"),
  };

  normalizeUrl(contents.serverUrl, "serverUrl");

  if (!contents.accessToken && !contents.refreshToken) {
    throw usageError(`Credentials file "${filePath}" does not contain OAuth tokens.`);
  }

  if (contents.refreshToken && !contents.clientId) {
    throw usageError(
      `Credentials file "${filePath}" with refreshToken requires clientId.`,
    );
  }

  if (contents.expiresAt) {
    assertValidDate(contents.expiresAt, "expiresAt");
  }

  return contents;
}

function optionalStringField(
  value: Record<string, unknown>,
  key: keyof Omit<CredentialsFileContents, "version" | "serverUrl">,
): Partial<CredentialsFileContents> {
  const entry = value[key];
  if (entry === undefined) {
    return {};
  }

  return { [key]: requireString(entry, key) };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw usageError(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function assertValidDate(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw usageError(`${label} must be a valid ISO timestamp.`);
  }
}

function assertMatchingServerUrl(
  credentialsServerUrl: string,
  serverUrl: string,
  filePath: string,
): void {
  if (
    normalizeUrl(credentialsServerUrl, "credentials file serverUrl") ===
    normalizeUrl(serverUrl, "server URL")
  ) {
    return;
  }

  throw usageError(
    `Credentials file "${filePath}" was issued for ${credentialsServerUrl}, not ${serverUrl}.`,
  );
}

function normalizeUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`${label} must use http or https: ${value}`);
  }

  const normalizedPathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return `${parsed.origin}${normalizedPathname}${parsed.search}`;
}

function isAccessTokenUsable(
  contents: Pick<CredentialsFileContents, "expiresAt">,
  now: Date,
): boolean {
  if (!contents.expiresAt) {
    return true;
  }

  return Date.parse(contents.expiresAt) - now.getTime() > ACCESS_TOKEN_EXPIRY_SKEW_MS;
}
