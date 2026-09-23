import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Guards the public URLs of the generated API reference on docs.mcpjam.com.
// Mintlify derives each endpoint page's URL from the operation's first tag and
// its summary — /api-reference/{tag}/{summary} — so a vocabulary rename in
// docs/reference/openapi.json (hosts → clients, user-testing → studies, wave →
// swarm run) silently moves the page. Four such renames left 44 URLs returning
// 404 to search engines and to anyone holding a link.
//
// docs/reference/published-api-pages.json is the ledger of every URL the spec
// has ever produced. Every page the spec produces today must be in it, and
// every URL in it that the spec no longer produces must redirect, in
// docs/docs.json, to a page that still exists.

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, "../../../../../docs");

const spec = JSON.parse(
  readFileSync(resolve(docsDir, "reference/openapi.json"), "utf8"),
) as {
  paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
};
const docsConfig = JSON.parse(
  readFileSync(resolve(docsDir, "docs.json"), "utf8"),
) as { redirects?: Array<{ source: string; destination: string }> };
const ledger = JSON.parse(
  readFileSync(resolve(docsDir, "reference/published-api-pages.json"), "utf8"),
) as string[];

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

// Mintlify's slug rule, checked against the live sitemap: punctuation is
// dropped rather than turned into a separator ("a host's" → "a-hosts",
// "OTLP/JSON" → "otlpjson").
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const generated: Array<{ url: string; operation: string }> = [];
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!HTTP_METHODS.has(method)) continue;
    const tag = op.tags?.[0] ?? "default";
    const summary = op.summary ?? `${method} ${path}`;
    generated.push({
      url: `/api-reference/${slugify(tag)}/${slugify(summary)}`,
      operation: `${method.toUpperCase()} ${path}`,
    });
  }
}
const current = new Set(generated.map((g) => g.url));
const redirects = new Map(
  (docsConfig.redirects ?? []).map((r) => [r.source, r.destination]),
);

describe("API reference URLs", () => {
  it("gives every operation its own page", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { url, operation } of generated) {
      const other = seen.get(url);
      if (other) collisions.push(`${url}: ${other} and ${operation}`);
      seen.set(url, operation);
    }
    expect(collisions, "two operations share a tag and summary").toEqual([]);
  });

  it("records every published page in the ledger", () => {
    const known = new Set(ledger);
    const missing = [...current].filter((url) => !known.has(url)).sort();
    expect(
      missing,
      "add these to docs/reference/published-api-pages.json — once published, a URL must keep resolving",
    ).toEqual([]);
  });

  it("redirects every retired URL to a page that exists", () => {
    const problems: string[] = [];
    for (const url of ledger) {
      if (current.has(url)) continue;
      const destination = redirects.get(url);
      if (!destination) {
        problems.push(`${url} has no redirect in docs/docs.json`);
      } else if (
        destination.startsWith("/api-reference/") &&
        !current.has(destination)
      ) {
        problems.push(`${url} redirects to ${destination}, which is gone too`);
      }
    }
    expect(problems).toEqual([]);
  });
});
