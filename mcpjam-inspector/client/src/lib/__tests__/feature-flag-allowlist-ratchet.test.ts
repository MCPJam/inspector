import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { CLIENT_FEATURE_FLAG_KEYS } from "../../../../shared/client-feature-flags";

/**
 * Ratchet for the server-evaluated flag allowlist (MJ-015).
 *
 * `GET /api/web/flags` evaluates only the keys in
 * shared/client-feature-flags.ts, so a flag the client reads but the list
 * lacks is never on. This test reads every flag lookup in client/src and
 * fails when:
 *   - a lookup names a key that is not in the allowlist (add it there), or
 *   - a lookup's key cannot be resolved statically (pass a string literal or
 *     a `const` holding one), or
 *   - an allowlisted key is no longer read anywhere (remove it there).
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

const FLAG_LOOKUP =
  /\b(?:useFeatureFlagEnabled|useFeatureFlagVariantKey|useFeatureFlagPayload|useFeatureFlagResult|isFeatureEnabled|getFeatureFlag|getFeatureFlagPayload|getFeatureFlagResult)\(\s*([^,)]*?)\s*[,)]/g;
const CONSTANT = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__")
        continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const sources = sourceFiles(CLIENT_SRC).map((file) => ({
  file: relative(CLIENT_SRC, file).split(sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

const constants = new Map<string, string[]>();
for (const { text } of sources) {
  for (const [, name, expression] of text.matchAll(CONSTANT)) {
    constants.set(name, [...(constants.get(name) ?? []), expression.trim()]);
  }
}

// String literal, `const` name, or `cond ? A : B` over those.
function resolveKeys(expression: string, depth = 0): string[] | null {
  const trimmed = expression.trim();
  const literal = /^(["'`])([^"'`$]+)\1$/.exec(trimmed);
  if (literal) return [literal[2]];
  if (depth > 4) return null;
  const ternary = /^[^?]+\?([^:]+):(.+)$/s.exec(trimmed);
  if (ternary) {
    const left = resolveKeys(ternary[1], depth + 1);
    const right = resolveKeys(ternary[2], depth + 1);
    return left && right ? [...left, ...right] : null;
  }
  const values = /^[A-Z][A-Z0-9_]*$/.test(trimmed)
    ? constants.get(trimmed)
    : undefined;
  if (!values) return null;
  const keys: string[] = [];
  for (const value of values) {
    const resolved = resolveKeys(value, depth + 1);
    if (!resolved) return null;
    keys.push(...resolved);
  }
  return keys;
}

const readKeys = new Set<string>();
const unresolved: string[] = [];
for (const { file, text } of sources) {
  for (const [, argument] of text.matchAll(FLAG_LOOKUP)) {
    const keys = resolveKeys(argument);
    if (keys) keys.forEach((key) => readKeys.add(key));
    else unresolved.push(`${file}: ${argument}`);
  }
}

describe("server-evaluated flag allowlist", () => {
  const allowlist = new Set<string>(CLIENT_FEATURE_FLAG_KEYS);

  it("finds the client's flag lookups", () => {
    expect(readKeys.size).toBeGreaterThan(10);
  });

  it("resolves every flag lookup to a literal key", () => {
    expect(unresolved).toEqual([]);
  });

  it("allowlists every key the client reads", () => {
    expect([...readKeys].filter((key) => !allowlist.has(key))).toEqual([]);
  });

  it("lists no key the client no longer reads", () => {
    expect(
      CLIENT_FEATURE_FLAG_KEYS.filter((key) => !readKeys.has(key)),
    ).toEqual([]);
  });
});
