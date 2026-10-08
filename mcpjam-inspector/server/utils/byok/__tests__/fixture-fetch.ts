import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixture-backed `fetch` for the adapter contract tests: no network.
 *
 * The fixtures under `fixtures/` follow each provider's documented list
 * response shape, trimmed to a few entries. They were written for these tests
 * rather than captured from a live account, and hold no key
 * (`no-secrets.test.ts` guards that).
 */

export const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

/** Placeholder key the tests send. Never a real key. */
export const PLACEHOLDER_KEY = "sk-fixture-placeholder";

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

export type FixtureRoute = {
  /** Exact URL, or a predicate over it. */
  match: string | ((url: URL) => boolean);
  status?: number;
  /** Fixture file name, or an inline body. */
  fixture?: string;
  body?: unknown;
  /** Answer with a body that is not JSON. */
  rawBody?: string;
  /** Reject the request as a network failure. */
  networkError?: boolean;
};

export function fixtureFetch(routes: FixtureRoute[]) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, method: init?.method ?? "GET", headers });
    const parsed = new URL(url);
    const route = routes.find((candidate) =>
      typeof candidate.match === "string"
        ? candidate.match === url
        : candidate.match(parsed),
    );
    if (!route) {
      throw new Error(`fixtureFetch: no route for ${url}`);
    }
    if (route.networkError) {
      throw new TypeError("fetch failed");
    }
    const text =
      route.rawBody ??
      JSON.stringify(
        route.fixture !== undefined ? loadFixture(route.fixture) : route.body,
      );
    return new Response(text, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
