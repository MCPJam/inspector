import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callbackCases,
  checkCallbacks,
  environments,
  probeCallback,
} from "./check-workos-loopback.mjs";

const config = environments.production;
const uri = "http://127.0.0.1:6276/callback";
const response = (location, status = 302) =>
  new Response(null, {
    status,
    headers: location === undefined ? {} : { location },
  });

test("uses the production client, exact callback and fresh PKCE; never follows redirects", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return response(`${config.authkitOrigin}/bootstrap?opaque=not-logged`);
  };
  assert.equal(await probeCallback(config, uri, fetchImpl), true);
  assert.equal(await probeCallback(config, uri, fetchImpl), true);
  const { url, options } = requests[0];
  assert.equal(url.origin, "https://api.workos.com");
  assert.equal(url.searchParams.get("client_id"), config.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), uri);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge").length, 43);
  assert.notEqual(
    url.searchParams.get("state"),
    requests[1].url.searchParams.get("state"),
  );
  assert.equal(options.redirect, "manual");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers, undefined);
});

test("recognizes the user's production redirect rejection", async () => {
  assert.equal(
    await probeCallback(config, uri, async () =>
      response(
        `${config.authkitOrigin}/redirect-uri-invalid?invalid_redirect_uri=${encodeURIComponent(uri)}`,
      ),
    ),
    false,
  );
});

for (const [name, location, status] of [
  ["a Cloudflare challenge", undefined, 403],
  ["a rate limit", undefined, 429],
  ["a server failure", undefined, 503],
  ["a login/error HTML page", undefined, 200],
  ["a missing Location", undefined, 302],
  ["a local callback", uri, 302],
  ["an untrusted bootstrap", "https://evil.invalid/bootstrap", 302],
  ["an unrelated AuthKit error", `${config.authkitOrigin}/error`, 302],
]) {
  test(`fails closed for ${name}`, async () => {
    await assert.rejects(
      probeCallback(config, uri, async () => response(location, status)),
    );
  });
}

test("network errors are not successes and do not leak upstream details", async () => {
  await assert.rejects(
    probeCallback(config, uri, async () => {
      throw new Error("secret-url-or-credential");
    }),
    { message: "WorkOS authorization probe failed or timed out" },
  );
});

test("matrix covers both loopback hosts, the reported port, arbitrary ports and lookalikes", () => {
  const cases = callbackCases(60001);
  assert.equal(cases.length, 10);
  assert.ok(cases.some((c) => c.uri === uri && c.allowed));
  for (const host of ["localhost", "127.0.0.1"]) {
    assert.ok(
      cases.some((c) => c.uri === `http://${host}:60001/callback` && c.allowed),
    );
  }
  assert.equal(cases.filter((c) => !c.allowed).length, 2);
});

test("a rejected legitimate callback fails while rejected lookalikes pass", async () => {
  const results = await checkCallbacks(
    config,
    callbackCases(60001),
    async () => false,
  );
  assert.equal(results.filter((r) => r.ok).length, 2);
});

test("accepting lookalikes fails; inconclusive probes also fail negative controls", async () => {
  const cases = callbackCases(60001);
  const accepted = await checkCallbacks(config, cases, async () => true);
  assert.equal(accepted.filter((r) => !r.ok).length, 2);
  const unavailable = await checkCallbacks(config, cases, async () => {
    throw new Error("unavailable");
  });
  assert.ok(unavailable.every((r) => !r.ok));
});

test("follows the known production authorization proxy once, stopping before bootstrap", async () => {
  const seen = [];
  const result = await probeCallback(config, uri, async (url, options) => {
    seen.push(String(url));
    assert.equal(options.redirect, "manual");
    return response(
      seen.length === 1
        ? `${config.authorizeProxy}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(uri)}`
        : `${config.authkitOrigin}/bootstrap`,
    );
  });
  assert.equal(result, true);
  assert.equal(seen.length, 2);
  assert.equal(new URL(seen[1]).origin, "https://auth.mcpjam.com");
});

test("rejects proxy loops instead of accepting or following indefinitely", async () => {
  let calls = 0;
  await assert.rejects(
    probeCallback(config, uri, async () => {
      calls += 1;
      return response(config.authorizeProxy);
    }),
  );
  assert.equal(calls, 2);
});

test("a redirect rejection after the known proxy remains a failure", async () => {
  let calls = 0;
  assert.equal(
    await probeCallback(config, uri, async () =>
      response(
        ++calls === 1
          ? config.authorizeProxy
          : `${config.authkitOrigin}/redirect-uri-invalid`,
      ),
    ),
    false,
  );
});
