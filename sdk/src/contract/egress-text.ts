/**
 * The egress redactor, byte-identical to the hosted one.
 *
 * The v5 goal judge redacts the authored task and the recorded evidence with
 * ONE map before the model reads them, and hashes what it sent. A local judge
 * that redacted differently would read different bytes under the same
 * template hash, so everything between the MIRROR markers is copied verbatim
 * from the backend's `convex/lib/analysisEgressText.ts` and pinned there as
 * the `analysis-egress-text` mirror pair. Edit it on the backend side first.
 *
 * Pattern matching, not DLP: person names and street addresses are not
 * detected.
 */
import {
  isCredentialFieldName,
  redactCredentialString,
} from "./credential-redaction.js";

// ── MIRROR: analysis-egress-text BEGIN ──
// A const list, not a union literal: Prettier 3.8 (backend) and 3.9 (SDK)
// wrap a long union differently, and this region must stay byte-identical.
export const EGRESS_PII_KINDS = [
  "email",
  "phone",
  "card",
  "ssn",
  "ip",
  "url",
  "id",
] as const;
export type EgressPiiKind = (typeof EGRESS_PII_KINDS)[number];

export type EgressPiiPattern = {
  kind: EgressPiiKind;
  regex: RegExp;
  validate?: (match: string) => boolean;
};

function luhnValid(match: string): boolean {
  const digits = match.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Card networks issue from 2–6 (Mastercard 2/5, Amex/Diners/JCB 3, Visa 4,
 * Discover/UnionPay 6), plus UATP from 1 at exactly 15 digits. Epoch-ms
 * timestamps (13 digits) and snowflake ids (17–19) also start with 1, and
 * about one in ten of them passes Luhn by chance, so a model would read
 * `createdAt: [card-a]`. Those fall through to `id` instead. A UATP number
 * has to stay a card: written with spaces it matches no other pattern.
 */
function cardValid(match: string): boolean {
  const digits = match.replace(/[ -]/g, "");
  const network =
    (digits[0] >= "2" && digits[0] <= "6") ||
    (digits[0] === "1" && digits.length === 15);
  return network && luhnValid(match);
}

function ipv4Valid(match: string): boolean {
  return match.split(".").every((octet) => Number(octet) <= 255);
}

/**
 * Applied in this order. Card before id before phone: a Luhn-valid run with
 * a card-network prefix is a card, any other ≥13-digit run is an id (the
 * removed DLP pass's `PROVIDER_NUMERIC_ID`), and only what is left can be a
 * phone number.
 */
export const PII_PATTERNS: ReadonlyArray<EgressPiiPattern> = [
  {
    kind: "email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "card",
    regex: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: cardValid,
  },
  { kind: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "id", regex: /\b\d{13,}\b/g },
  {
    kind: "phone",
    regex:
      /(?:\+[1-9]\d{7,14}\b|\(\d{3}\)\s?\d{3}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b)/g,
  },
  {
    kind: "ip",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    validate: ipv4Valid,
  },
  { kind: "ip", regex: /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b/g },
  // Ends on a non-punctuation character, so a sentence's `.` / `;` / `)`
  // stays in the prose instead of vanishing into the token.
  { kind: "url", regex: /https?:\/\/[^\s"'<>]*[^\s"'<>.,;:!?)\]]/gi },
];

/**
 * Credential forms the ops-log redactor knows, minus its email rule (mapped
 * above instead). Constant marker: a credential is never correlated.
 */
const EGRESS_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{16,}/g,
  /(?<=[?&](?:token|key|secret|password|access_token|refresh_token)=)[^&\s]+/gi,
];

/** 0 → a, 25 → z, 26 → aa. Letters only, so no digit ever reaches a prompt. */
export function placeholderLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const EXISTING_PLACEHOLDER = /\[(email|phone|card|ssn|ip|url|id)-([a-z]+)\]/g;

/**
 * Record every placeholder ALREADY present in `text`, so a fresh assignment
 * never reuses one. Evidence scrubbed earlier (a stored excerpt, a ledger
 * record) can sit next to raw text in one prompt; without this, a new
 * `[email-a]` could name a different value than the stored `[email-a]` beside
 * it.
 */
export function reservePlaceholders(text: string, reserved: Set<string>): void {
  for (const match of text.matchAll(EXISTING_PLACEHOLDER))
    reserved.add(match[0]);
}

/** Mapped PII replacement with a caller-owned map. Exported for the SDK. */
export function replacePiiWithPlaceholders(
  text: string,
  map: Map<string, string>,
  counters: Map<EgressPiiKind, number>,
  reserved: Set<string> = new Set()
): string {
  let out = text;
  for (const pattern of PII_PATTERNS) {
    out = out.replace(pattern.regex, (match: string) => {
      if (pattern.validate && !pattern.validate(match)) return match;
      const key =
        pattern.kind === "email"
          ? `${pattern.kind}:${match.toLowerCase()}`
          : `${pattern.kind}:${match}`;
      let token = map.get(key);
      if (!token) {
        let next = counters.get(pattern.kind) ?? 0;
        do {
          token = `[${pattern.kind}-${placeholderLetters(next)}]`;
          next += 1;
        } while (reserved.has(token));
        counters.set(pattern.kind, next);
        reserved.add(token);
        map.set(key, token);
      }
      return token;
    });
  }
  return out;
}

export function redactEgressSecrets(text: string): string {
  let out = text;
  for (const pattern of EGRESS_SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

/** The old `sanitizeInsightErrorMessage` labeled-key rule, verbatim. */
export function redactLabeledKeys(text: string): string {
  return text.replace(
    /\b(api[_-]?key|token|secret)\b\s*[:=]\s*\S+/gi,
    "$1=[redacted]"
  );
}

export type EgressRedactor = {
  /**
   * Same contract as the old `redactedText`: a string is sanitized as is; any
   * other value is serialized with credential-named keys replaced, then
   * whitespace collapsed and clipped to `max`.
   */
  text(value: unknown, max?: number): string;
  /** One string, formatting kept, no clip. For prompt fields and walks. */
  string(value: string): string;
  /**
   * Structure-preserving walk: every string leaf (and every credential-named
   * key's value) redacted, everything else returned unchanged. For evidence
   * that is serialized AFTER redaction, so a hash over it covers the bytes
   * actually sent.
   */
  deep<T>(value: T): T;
  /**
   * Mark placeholders already present anywhere in `value` as taken. `text` and
   * `deep` do this for their own input; call it first when a prompt is built
   * from several `string` calls, some of which carry already-scrubbed text.
   */
  reserve(value: unknown): void;
  /** original → token; tests/diagnostics only, NEVER persisted or logged. */
  readonly placeholders: ReadonlyMap<string, string>;
};

const BINARY_DATA_THRESHOLD = 1000;

function clipWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function createEgressRedactor(): EgressRedactor {
  const keyed = new Map<string, string>();
  const counters = new Map<EgressPiiKind, number>();
  const placeholders = new Map<string, string>();
  const reserved = new Set<string>();
  const reserveAll = (value: unknown) => {
    try {
      reservePlaceholders(
        typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
        reserved
      );
    } catch {
      // Unserializable input: string leaves are still scanned one by one.
    }
  };

  const redactString = (value: string): string => {
    reservePlaceholders(value, reserved);
    const credentialFree = redactEgressSecrets(redactCredentialString(value));
    const sizeBefore = keyed.size;
    const out = replacePiiWithPlaceholders(
      credentialFree,
      keyed,
      counters,
      reserved
    );
    if (keyed.size !== sizeBefore) {
      // New entries are appended, so only the tail needs copying out.
      let index = 0;
      for (const [key, token] of keyed) {
        if (index++ >= sizeBefore)
          placeholders.set(key.slice(key.indexOf(":") + 1), token);
      }
    }
    return redactLabeledKeys(out);
  };

  const sanitize = (value: string, max: number): string =>
    clipWithEllipsis(redactString(value).replace(/\s+/g, " ").trim(), max + 1);

  const deep = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value && typeof value === "object" && isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] =
          isCredentialFieldName(key) && item !== null && item !== undefined
            ? "[REDACTED]"
            : deep(item);
      }
      return out;
    }
    return value;
  };

  return {
    text(value: unknown, max = 1600): string {
      reserveAll(value);
      const clean =
        typeof value === "string"
          ? sanitize(value, max)
          : (JSON.stringify(value, (key, item) => {
              if (isCredentialFieldName(key)) return "[REDACTED]";
              if (
                key === "data" &&
                typeof item === "string" &&
                item.length > BINARY_DATA_THRESHOLD
              )
                return "[binary data omitted]";
              return typeof item === "string" ? sanitize(item, max) : item;
            }) ?? "");
      return clean.length > max ? `${clean.slice(0, max)}…[truncated]` : clean;
    },
    string: redactString,
    reserve: reserveAll,
    deep: <T>(value: T): T => {
      reserveAll(value);
      return deep(value) as T;
    },
    placeholders,
  };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * For STORED model outputs (summaries, titles, cluster labels, discovery
 * strings): the model may echo a value the input scrub missed, or invent one.
 * Replace, never reject — a finding is not worth losing over an email in it.
 * A fresh map per call: tokens in a stored string mean "a redacted value",
 * not a reference into any prompt.
 */
export function scrubModelOutputText(text: string): string {
  return createEgressRedactor().string(text);
}
// ── MIRROR: analysis-egress-text END ──
