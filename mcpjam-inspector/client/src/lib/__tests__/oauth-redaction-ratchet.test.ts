import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Ratchet fence for OAuth trace redaction.
 *
 * The redaction policy has exactly one owner — the SDK's
 * `oauth/state-machines/trace-redaction.ts` — re-exported to the client through
 * `lib/oauth/trace-redaction.ts`, which adds the `SANITIZE_OAUTH_TRACES` gate.
 * That ownership is the whole point of the consolidation: the policy used to
 * exist in six places, and the copies had already drifted (`state` was
 * sensitive on one side and not the other).
 *
 * A naming convention alone does not survive contact with a codebase, so this
 * enforces it. `npm test` runs in CI; the lint workflow only runs typecheck and
 * build, so an eslint rule here would be decorative.
 *
 * If this fails because you added a redaction helper: put it in
 * `lib/oauth/trace-redaction.ts` (or the SDK module it re-exports) and import
 * it. If you genuinely need a new home for one, add the file here and say why.
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

/**
 * Identifiers reserved for the redaction modules. Matches definitions AND
 * usages: a usage outside the allowlist means someone imported the policy to
 * apply it somewhere new, which is exactly the review moment worth forcing.
 */
const REDACTION_IDENTIFIER_PATTERN =
  /\b(sanitizeOAuth[A-Za-z]*|redactSensitiveValue[A-Za-z]*|traceOAuth[A-Za-z]*)\b/;

const ALLOWED_FILES = new Set([
  // The gate + re-export. The policy itself lives in the SDK.
  "lib/oauth/trace-redaction.ts",
  // Builds the trace entries; calls the gated helpers, defines none.
  "lib/oauth/mcp-oauth.ts",
  "lib/oauth/oauth-trace.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("OAuth redaction ratchet", () => {
  it("keeps redaction identifiers inside the trace modules", () => {
    const offenders = sourceFiles(CLIENT_SRC)
      .filter((file) =>
        REDACTION_IDENTIFIER_PATTERN.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(CLIENT_SRC, file).split(sep).join("/"))
      .filter((file) => !ALLOWED_FILES.has(file));

    expect(offenders).toEqual([]);
  });

  it("does not define its own redaction policy outside the SDK", () => {
    const gate = readFileSync(
      join(CLIENT_SRC, "lib/oauth/trace-redaction.ts"),
      "utf8",
    );

    // The gate may wrap, but it must not re-implement: no local sensitive-field
    // list, and no local copy of the truncation shape.
    expect(gate).not.toMatch(/new Set\(\[[\s\S]{0,80}"access_token"/);
    expect(gate).not.toMatch(/slice\(0, 4\)/);
    expect(gate).toContain('from "@mcpjam/sdk/browser"');
  });

  it("has no stale allowlist entries", () => {
    const live = new Set(
      sourceFiles(CLIENT_SRC)
        .filter((file) =>
          REDACTION_IDENTIFIER_PATTERN.test(readFileSync(file, "utf8")),
        )
        .map((file) => relative(CLIENT_SRC, file).split(sep).join("/")),
    );

    expect([...ALLOWED_FILES].filter((file) => !live.has(file))).toEqual([]);
  });
});
