/**
 * The negotiation-header mechanics, over any header name.
 *
 * Two headers negotiate on `/api/v1` and they move on different schedules:
 * `x-mcpjam-eval-vocabulary` (the eval surface's field spellings and the
 * policy role) and `x-mcpjam-api-vocabulary` (the resource-noun VALUES the
 * scenario/journey/wave rename left behind). What they negotiate differs
 * entirely; HOW they negotiate must not.
 *
 * So the parse, the `Vary` and the refusal live here once and both modules
 * call them. A caller that has learned one header's behaviour has learned the
 * other's, and a fix to the `Vary` merge cannot land on one and miss the
 * other.
 */

import type { Context } from "hono";

/** The vocabularies a header may name. Both surfaces speak exactly these. */
export type Vocabulary = 1 | 2;

/**
 * Parse one header value. `null` means it was present and unrecognised — the
 * caller turns that into a `VALIDATION_ERROR` rather than guessing a
 * vocabulary for a client that asked for one we do not have.
 *
 * Only an ABSENT header defaults to 1. An explicitly empty one is refused with
 * every other unrecognised value: accepting it would make blank a third,
 * undocumented spelling of "1", so a client whose header came out empty by
 * accident would silently receive the legacy projection instead of the
 * validation error the negotiation promises. The refusal is the whole point —
 * a vocabulary mismatch has to be loud.
 */
export function parseVocabularyValue(
  raw: string | undefined,
): Vocabulary | null {
  if (raw === undefined) return 1;
  const value = raw.trim();
  if (value === "1") return 1;
  if (value === "2") return 2;
  return null;
}

/**
 * Append one header name to the response's `Vary`, without dropping an axis
 * that is already there or repeating one that is.
 *
 * Set on every negotiated response rather than only when the body actually
 * differs: a cache keyed on the wrong axis serves one client another client's
 * spelling, and "this response happened not to contain a renamed value" is not
 * a property a cache can see.
 */
export function appendVaryHeader(c: Context, header: string): void {
  const existing = c.res?.headers?.get("Vary");
  if (!existing) {
    c.header?.("Vary", header);
    return;
  }
  const names = existing
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes(header)) return;
  c.header?.("Vary", `${existing}, ${header}`);
}

/** The message a refused header gets, naming the header and both valid values. */
export function unknownVocabularyMessage(header: string): string {
  return (
    `Unknown ${header}: send "1" (today's contract, the default when the ` +
    `header is absent) or "2".`
  );
}

/**
 * The vocabulary this request negotiated for one header, appending `Vary`.
 *
 * An unrecognised value reads as 1 here; the route asks
 * {@link hasUnknownVocabularyValue} separately and refuses. Two calls rather
 * than one union return because the refusal and the projection happen at
 * different points in a handler — the `Vary` must be on the response even when
 * the request is about to be refused.
 */
export function vocabularyForHeader(c: Context, header: string): Vocabulary {
  const parsed = parseVocabularyValue(c.req.header(header));
  appendVaryHeader(c, header);
  return parsed ?? 1;
}

/** True when the request named a vocabulary this deployment does not speak. */
export function hasUnknownVocabularyValue(c: Context, header: string): boolean {
  return parseVocabularyValue(c.req.header(header)) === null;
}
