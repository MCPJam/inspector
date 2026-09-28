/**
 * Value-based secret scrubbing for a local run.
 *
 * Pattern redaction (`redactTelemetryString`) catches credentials that LOOK
 * like credentials — an `authorization:` header, a `Bearer` token, an
 * `access_token=` parameter. A provider error that quotes the key it was
 * given in some other shape (`invalid x-api-key sk-ant-…`) slips past every
 * pattern. The runner, unlike a generic redactor, knows the exact secrets it
 * was handed: provider keys, server credentials and headers, stdio env
 * values, token-bearing URL parameters, and every platform bearer its auth
 * callback returns. Those VALUES are scrubbed from every string the result
 * and its errors carry, so no terminal — JSON, JUnit, HTML, human, an error —
 * can print one.
 */

import { redactTelemetryString } from "../telemetry-redaction.js";

/** Shorter values are too likely to be ordinary words to scrub safely. */
const MIN_SECRET_LENGTH = 6;
const REDACTED = "[REDACTED]";

export type SecretScrubber = {
  add: (value: unknown) => void;
  /** Pattern redaction, then every known secret value replaced. */
  scrub: (text: string) => string;
  /** Scrub every string inside a JSON-like value (a new value is returned). */
  scrubDeep: <T>(value: T) => T;
};

export function createSecretScrubber(): SecretScrubber {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) values.add(trimmed);
    // A bearer header value is also scrubbed without its scheme.
    const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
    if (bearer?.[1] && bearer[1].length >= MIN_SECRET_LENGTH)
      values.add(bearer[1]);
  };
  const scrub = (text: string) => {
    let out = redactTelemetryString(text);
    // Longest first, so a secret that contains another is removed whole.
    for (const value of [...values].sort(
      (left, right) => right.length - left.length
    )) {
      if (out.includes(value)) out = out.split(value).join(REDACTED);
    }
    return out;
  };
  const scrubDeep = <T>(value: T): T => {
    if (typeof value === "string") return scrub(value) as T;
    if (Array.isArray(value))
      return value.map((entry) => scrubDeep(entry)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>
      )) {
        out[key] = scrubDeep(entry);
      }
      return out as T;
    }
    return value;
  };
  return { add, scrub, scrubDeep };
}

/** Collect the secret values an MCP server config carries. */
export function addServerConfigSecrets(
  scrubber: SecretScrubber,
  config: unknown
): void {
  if (!config || typeof config !== "object") return;
  const record = config as Record<string, unknown>;
  for (const key of ["accessToken", "refreshToken", "clientSecret"])
    scrubber.add(record[key]);
  const requestInit = record.requestInit as { headers?: unknown } | undefined;
  const headers = requestInit?.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const value of Object.values(headers as Record<string, unknown>))
      scrubber.add(value);
  }
  const env = record.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const value of Object.values(env as Record<string, unknown>))
      scrubber.add(value);
  }
  if (typeof record.url === "string") {
    try {
      const url = new URL(record.url);
      for (const value of url.searchParams.values()) scrubber.add(value);
      if (url.password) scrubber.add(decodeURIComponent(url.password));
    } catch {
      // Not a URL; nothing to extract.
    }
  }
}
