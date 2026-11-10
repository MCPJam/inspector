import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Ratchet for PLB-506: every MCPJam account sign-in starts through
 * `useInspectorAuth`. Its guard shows where sign-in works when the page is at
 * an HTTP address, where browsers hide `crypto.subtle` and AuthKit's PKCE hash
 * would throw before WorkOS is reached.
 *
 * If this fails, take `signIn`/`signUp` from `useInspectorAuth`
 * (`@/hooks/use-inspector-auth`) instead of AuthKit's `useAuth`.
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

const AUTHKIT_IMPORT = /from\s+["']@workos-inc\/authkit-(?:react|js)["']/;
const AUTH_START =
  /\b(?:signIn|signUp|switchToOrganization|getSignInUrl|getSignUpUrl)\b/;
/** AuthKit entry points that also hash, and that the guarded hook does not wrap. */
const UNWRAPPED_AUTH_START =
  /\b(?:switchToOrganization|getSignInUrl|getSignUpUrl)\b/;

const ALLOWED = new Set([
  "hooks/use-inspector-auth.ts",
  // Plugin-server OAuth: its `signIn` never calls WorkOS.
  "hooks/usePluginServerSignIn.ts",
]);

function startsAuthUnguarded(source: string): boolean {
  return AUTHKIT_IMPORT.test(source) && AUTH_START.test(source);
}

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

describe("WorkOS sign-in guard ratchet (PLB-506)", () => {
  const files = sourceFiles(CLIENT_SRC).map((file) => ({
    path: relative(CLIENT_SRC, file).split(sep).join("/"),
    source: readFileSync(file, "utf8"),
  }));

  it("starts account sign-in only through useInspectorAuth", () => {
    expect(
      files
        .filter(
          ({ path, source }) =>
            !ALLOWED.has(path) && startsAuthUnguarded(source),
        )
        .map(({ path }) => path),
    ).toEqual([]);
  });

  it("never uses the AuthKit entry points the guarded hook does not wrap", () => {
    expect(
      files
        .filter(({ source }) => UNWRAPPED_AUTH_START.test(source))
        .map(({ path }) => path),
    ).toEqual([]);
  });

  it("recognizes the shapes it guards against", () => {
    for (const sample of [
      'import { useAuth } from "@workos-inc/authkit-react";\nconst { user, signIn } = useAuth();',
      'import { useAuth as useWorkOS } from "@workos-inc/authkit-react";\nconst auth = useWorkOS();\nawait auth.signUp();',
      'import { createClient } from "@workos-inc/authkit-js";\nlocation.assign(await client.getSignInUrl());',
    ]) {
      expect(startsAuthUnguarded(sample), sample).toBe(true);
    }
    for (const sample of [
      'import { useAuth } from "@workos-inc/authkit-react";\nconst { user } = useAuth();',
      'import { useInspectorAuth } from "@/hooks/use-inspector-auth";\nconst { signIn } = useInspectorAuth();',
      "// authkit-js mints the verifier when the app calls signIn()",
    ]) {
      expect(startsAuthUnguarded(sample), sample).toBe(false);
    }
  });
});
