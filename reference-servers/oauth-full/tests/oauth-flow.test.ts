import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createReferenceServer, type ReferenceServer } from "../src/http.js";

let server: ReferenceServer;
let origin: string;

beforeAll(async () => {
  const config = parseConfig(["--port", "0", "--label", "vitest"]);
  config.captureDir = mkdtempSync(join(tmpdir(), "oauth-ref-"));
  server = createReferenceServer(config);
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const address = server.httpServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  // Rebuild advertised URLs against the ephemeral port.
  config.publicUrl = origin;
});

afterAll(async () => {
  await server.close();
});

describe("oauth reference server", () => {
  it("serves PRM and AS metadata", async () => {
    const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(`${origin}/mcp`);
    expect(prm.authorization_servers).toEqual([origin]);

    const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    expect(meta.issuer).toBe(origin);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.registration_endpoint).toBe(`${origin}/register`);
  });

  it("401s unauthenticated MCP requests with a resource_metadata challenge", async () => {
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("completes DCR + PKCE + token + authenticated MCP call, and derives traits", async () => {
    const redirectUri = "http://127.0.0.1:33418/callback";
    const reg = await (
      await fetch(`${origin}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "vitest-client",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json();
    expect(reg.client_id).toBeTruthy();

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${origin}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      state: "st4te",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:tools mcp:resources mcp:prompts",
      resource: `${origin}/mcp`,
    }).toString();
    const authRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("st4te");
    const code = location.searchParams.get("code")!;

    // Wrong verifier must be rejected.
    const bad = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client_id,
        redirect_uri: redirectUri,
        code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      }),
    });
    expect(bad.status).toBe(400);

    // A rejected exchange must not consume the code? (RFC: it should be
    // invalidated — our store marks used only on success, matching AS
    // implementations that allow retry until expiry. Re-issue a code.)
    const authRes2 = await fetch(authorizeUrl, { redirect: "manual" });
    const code2 = new URL(authRes2.headers.get("location")!).searchParams.get("code")!;

    const tokens = await (
      await fetch(`${origin}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          client_id: reg.client_id,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: `${origin}/mcp`,
        }),
      })
    ).json();
    expect(tokens.access_token).toMatch(/^ref_at_/);
    expect(tokens.refresh_token).toMatch(/^ref_rt_/);

    const init = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const initText = await init.text();
    expect(initText).toContain("mcpjam-oauth-reference-server");

    // Refresh rotation: old token becomes invalid after use.
    const refreshed = await (
      await fetch(`${origin}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: reg.client_id,
        }),
      })
    ).json();
    expect(refreshed.access_token).toBeTruthy();
    const reuse = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: reg.client_id,
      }),
    });
    expect(reuse.status).toBe(400);

    // Derived traits reflect the run.
    const report = await (await fetch(`${origin}/capture/report`)).json();
    expect(report.traits.completedFlow).toBe(true);
    expect(report.traits.registration.strategy).toBe("dcr");
    expect(report.traits.registration.dcrIdentity.clientName).toBe("vitest-client");
    expect(report.traits.authorization.usedPkce).toBe(true);
    expect(report.traits.authorization.scopeRequestPolicy).toBe("challenge-derived");
    expect(report.traits.authorization.sendsResourceParamAuthorize).toBe(true);
    expect(report.traits.token.refreshSucceeded).toBe(true);
    expect(report.oauthProfile.authClass).toBe("oauth");
    expect(report.oauthProfile.registrationStrategy).toBe("dcr");
    expect(report.oauthProfile.sendsResourceParam).toBe(true);
  });
});
