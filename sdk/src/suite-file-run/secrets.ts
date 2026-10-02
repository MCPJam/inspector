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
 * callback returns. Those VALUES are scrubbed from every piece of OBSERVED
 * text the result and its errors carry — execution errors, tool-call
 * arguments, evaluator and predicate reasons, issue and refusal messages,
 * warnings — so no terminal (JSON, JUnit, HTML, human, an error) can print
 * one.
 *
 * Which config values count: explicit credentials always; a header,
 * environment or URL-query value when its NAME says it is one
 * (`Authorization`, `GITHUB_TOKEN`, `?sig=`) or its SHAPE does (a known token
 * prefix, or a long run of mixed letters and digits). `NODE_ENV=production`
 * or `x-client: mcpjam` is configuration, and scrubbing it would redact the
 * word from every error that mentions it.
 *
 * Observed text only. A secret value can still be an ordinary word, so a
 * blanket scrub would rewrite the case id `c_github_search` to
 * `c_[REDACTED]_search` and a lifecycle status to `[REDACTED]`, and the
 * report would no longer satisfy its own contract. Identifiers (case,
 * server, tool, scorer and span ids) and closed vocabularies (statuses,
 * verdicts, stage states, policy reasons) come from the authored file, the
 * server's catalog or this SDK: a secret cannot reach the result through
 * them, so they are never rewritten.
 */

import { redactTelemetryString } from "../telemetry-redaction.js";
import type { SuiteFileRunErrorDetails } from "./errors.js";
import type { SuiteFileIterationEvidence, SuiteFileRunIssue } from "./types.js";

/**
 * An unclassified value is a secret only when it is at least this long AND
 * shaped like a credential (`looksLikeCredential`): shorter values are too
 * likely to be ordinary words to scrub safely.
 */
const MIN_UNCLASSIFIED_SECRET_LENGTH = 6;
/**
 * A value KNOWN to be a credential — a provider key, a bearer, a
 * credential-named header or variable — is scrubbed from this length: a short
 * password is still a password. Below it, replacing every occurrence would
 * garble unrelated text and protect nothing a guess would not find.
 */
const MIN_CREDENTIAL_LENGTH = 4;
const REDACTED = "[REDACTED]";

export type SecretScrubber = {
  /** Register a value known to be a credential (see `MIN_CREDENTIAL_LENGTH`). */
  add: (value: unknown) => void;
  /** Pattern redaction, then every known secret value replaced. */
  scrub: (text: string) => string;
  /** Scrub every string inside a JSON-like value (a new value is returned). */
  scrubDeep: <T>(value: T) => T;
};

export function createSecretScrubber(): SecretScrubber {
  const values = new Set<string>();
  // Longest first, so a secret that contains another is removed whole.
  // Sorted once per new secret, not once per string scrubbed.
  let ordered: string[] | undefined;
  const remember = (value: string) => {
    if (value.length < MIN_CREDENTIAL_LENGTH || values.has(value)) return;
    values.add(value);
    ordered = undefined;
  };
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    remember(trimmed);
    // A bearer header value is also scrubbed without its scheme.
    const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
    if (bearer?.[1]) remember(bearer[1]);
  };
  const scrub = (text: string) => {
    let out = redactTelemetryString(text);
    ordered ??= [...values].sort((left, right) => right.length - left.length);
    for (const value of ordered) {
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

/**
 * Words of a header, variable or parameter name that mark its value as a
 * credential. Matched whole (`PATH` is not `PAT`, `AUTHOR` is not `AUTH`),
 * plus the fragments below for names written as one word (`APITOKEN`).
 */
const SENSITIVE_NAME_WORDS: ReadonlySet<string> = new Set([
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "code",
  "cookie",
  "credential",
  "credentials",
  "dsn",
  "jwt",
  "key",
  "pass",
  "passphrase",
  "passwd",
  "password",
  "pat",
  "private",
  "pwd",
  "secret",
  "secrets",
  "session",
  "sid",
  "sig",
  "signature",
  "token",
  "tokens",
]);
const SENSITIVE_NAME_FRAGMENTS = [
  "apikey",
  "authorization",
  "credential",
  "passwd",
  "password",
  "secret",
  "token",
];

export function isSensitiveName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  if (words.some((word) => SENSITIVE_NAME_WORDS.has(word))) return true;
  const squashed = words.join("");
  return SENSITIVE_NAME_FRAGMENTS.some((fragment) =>
    squashed.includes(fragment)
  );
}

/** Prefixes of widely used token formats, whatever the variable is called. */
const CREDENTIAL_PREFIX =
  /^(?:(?:sk|pk|rk)[-_]|gh[opsur]_|github_pat_|xox[abposr]-|glpat-|npm_|hf_|AKIA|ASIA|AIza|ya29\.|eyJ[A-Za-z0-9_-]{8,}\.)/;

/**
 * Whether a value is shaped like a credential: a known token prefix, or a
 * long unbroken run that mixes letters and digits (hex, base64, a JWT). Not a
 * URL — the credentials a URL carries are taken from its parts.
 */
export function looksLikeCredential(value: string): boolean {
  if (value.length < MIN_UNCLASSIFIED_SECRET_LENGTH || /\s/.test(value))
    return false;
  if (value.includes("://")) return false;
  if (CREDENTIAL_PREFIX.test(value)) return true;
  return value.length >= 20 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

/** The credentials a URL carries: its password, and sensitive parameters. */
function addUrlSecrets(scrubber: SecretScrubber, value: unknown): void {
  if (typeof value !== "string" || !value.includes("://")) return;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return;
  }
  if (url.password) scrubber.add(decodeURIComponent(url.password));
  for (const [name, parameter] of url.searchParams) {
    if (isSensitiveName(name) || looksLikeCredential(parameter))
      scrubber.add(parameter);
  }
}

/** A named config value: a credential by its name, its shape, or its URL. */
function addNamedValue(
  scrubber: SecretScrubber,
  name: string,
  value: unknown
): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (isSensitiveName(name) || looksLikeCredential(trimmed)) {
    scrubber.add(trimmed);
  } else {
    // `Bearer <token>` under an innocuous name is still a bearer.
    const bearer = /^bearer\s+(\S+)$/i.exec(trimmed);
    if (bearer?.[1]) scrubber.add(bearer[1]);
  }
  addUrlSecrets(scrubber, trimmed);
}

/** Collect the credentials among request headers, by name or shape. */
export function addHeaderSecrets(
  scrubber: SecretScrubber,
  headers: unknown
): void {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return;
  for (const [name, value] of Object.entries(
    headers as Record<string, unknown>
  ))
    addNamedValue(scrubber, name, value);
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
  addHeaderSecrets(scrubber, requestInit?.headers);
  const env = record.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [name, value] of Object.entries(env as Record<string, unknown>))
      addNamedValue(scrubber, name, value);
  }
  addUrlSecrets(scrubber, record.url);
}

/**
 * One iteration's evidence with its observed text scrubbed: the execution
 * error, tool-call argument values (never their keys) and raw argument text,
 * evaluator reasons and predicate reasons. Everything else is identity or a closed vocabulary.
 */
export function scrubIterationEvidence(
  scrubber: SecretScrubber,
  evidence: SuiteFileIterationEvidence
): SuiteFileIterationEvidence {
  return {
    ...evidence,
    ...(evidence.error !== undefined
      ? { error: scrubber.scrub(evidence.error) }
      : {}),
    toolCalls: evidence.toolCalls.map((call) => ({
      ...call,
      arguments: scrubber.scrubDeep(call.arguments),
      ...(call.rawArguments !== undefined
        ? { rawArguments: scrubber.scrub(call.rawArguments) }
        : {}),
    })),
    scores: evidence.scores.map((score) =>
      score.reason !== undefined
        ? { ...score, reason: scrubber.scrub(score.reason) }
        : score
    ),
    ...(evidence.stage
      ? { stage: scrubStagePredicateReasons(scrubber, evidence.stage) }
      : {}),
  };
}

/** A stage chain's only observed text is its rows' predicate reasons. */
function scrubStagePredicateReasons(
  scrubber: SecretScrubber,
  stage: Record<string, unknown>
): Record<string, unknown> {
  const rows = stage.stageResults;
  if (!Array.isArray(rows)) return stage;
  return {
    ...stage,
    stageResults: rows.map((row: unknown) => {
      const evidence = (row as { evidence?: { predicateReasons?: unknown } })
        ?.evidence;
      if (!evidence || !Array.isArray(evidence.predicateReasons)) return row;
      return {
        ...(row as Record<string, unknown>),
        evidence: {
          ...evidence,
          predicateReasons: evidence.predicateReasons.map((reason: unknown) =>
            typeof reason === "string" ? scrubber.scrub(reason) : reason
          ),
        },
      };
    }),
  };
}

export function scrubIssue(
  scrubber: SecretScrubber,
  issue: SuiteFileRunIssue
): SuiteFileRunIssue {
  return { ...issue, message: scrubber.scrub(issue.message) };
}

/** A refusal's problems keep their structured identity; only prose is scrubbed. */
export function scrubErrorDetails(
  scrubber: SecretScrubber,
  details: SuiteFileRunErrorDetails
): SuiteFileRunErrorDetails {
  if (!details.problems) return details;
  return {
    ...details,
    problems: details.problems.map((problem) => ({
      ...problem,
      message: scrubber.scrub(problem.message),
    })),
  };
}
