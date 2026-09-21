// Run against the isolated multi-account lab with linked_resource/upstream_account.
// Prints assertions only; authorization codes and tokens never leave this process.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  MCPClientManager,
  captureOpenAIProfile,
  mergeConnectionToolsets,
} from "../dist/index.js";
const base = process.env.MULTI_ACCOUNT_LAB_URL ?? "http://127.0.0.1:18811";
const redirect = "http://127.0.0.1:18812/callback";
async function post(path, body, options = {}) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
  assert.ok(response.status < 400, `Lab ${path} returned ${response.status}`);
  return response;
}
const registration = await (
  await post("/register", {
    client_name: "MCPJam account isolation test",
    redirect_uris: [redirect],
  })
).json();
async function authorize(accountId) {
  const verifier = randomBytes(32).toString("base64url");
  const approved = await post(
    "/authorize/approve",
    {
      account_id: accountId,
      client_id: registration.client_id,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    },
    { redirect: "manual" }
  );
  const code = new URL(approved.headers.get("location")).searchParams.get(
    "code"
  );
  return (
    await post("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: registration.client_id,
    })
  ).json();
}
const accounts = ["ws_acme_7f3a91", "ws_side_2b8c04"];
const tokens = await Promise.all(accounts.map(authorize));
const a = {
  serverId: "lab",
  connectionId: "a".repeat(32),
  key: "lab",
  label: "Acme",
  isDefault: true,
};
const b = {
  serverId: "lab",
  connectionId: "b".repeat(32),
  key: "lab#" + "b".repeat(32),
  label: "Side",
  isDefault: false,
};
const configs = Object.fromEntries(
  [a, b].map((c, i) => [
    c.key,
    { url: base + "/mcp", accessToken: tokens[i].access_token },
  ])
);
const manager = new MCPClientManager(configs);
try {
  const profiles = await Promise.all(
    [a, b].map((c) =>
      captureOpenAIProfile(manager, c.key, { timeoutMs: 8_000 })
    )
  );
  assert.deepEqual(
    profiles.map((p) => p.profile?.id),
    accounts
  );
  assert.equal(profiles[0].profile.email, profiles[1].profile.email);
  const snapshot = new Map([a, b].map((c) => [c.connectionId, c.key]));
  const tools = mergeConnectionToolsets(
    await manager.getToolsForAiSdkByServer([a.key, b.key]),
    { lab: [a, b] },
    { snapshot }
  );
  const input = { account: b.connectionId };
  const options = { toolCallId: "side-resource", messages: [] };
  const raw = await tools.linked_resource.execute(input, options);
  const output = await tools.linked_resource.toModelOutput({
    ...options,
    input,
    output: raw,
  });
  const serialized = JSON.stringify(output);
  const variant = Object.keys(tools).find(
    (name) => name.startsWith("upstream_account__") && name.endsWith("side")
  );
  assert.ok(variant);
  const echoed = await tools[variant].execute(
    { account: "upstream-value" },
    { ...options, toolCallId: "collision" }
  );
  assert.match(JSON.stringify(echoed), /upstream-value/);
  const before = await (await fetch(base + "/inspect/events")).json();
  const rejected = await tools.linked_resource.execute(
    { account: "foreign" },
    { ...options, toolCallId: "foreign" }
  );
  assert.equal(rejected.isError, true);
  const after = await (await fetch(base + "/inspect/events")).json();
  assert.equal(after.events.length, before.events.length);
  const fresh = await (
    await post("/token", {
      grant_type: "refresh_token",
      refresh_token: tokens[1].refresh_token,
      client_id: registration.client_id,
    })
  ).json();
  await manager.disconnectServer(b.key);
  await manager.connectToServer(b.key, {
    ...configs[b.key],
    accessToken: fresh.access_token,
  });
  assert.equal(
    (await captureOpenAIProfile(manager, b.key)).profile?.id,
    accounts[1]
  );
  const resourceReads = after.events.filter((e) => e.rpc === "resources/read");
  assert.ok(
    resourceReads.length > 0 &&
      resourceReads.every((e) => e.accountId === accounts[1])
  );

  // Only now ask each connection for the resource directly: this compares the
  // conversion against what each credential actually returns, and it has to
  // come AFTER the assertion above or its own reads would pollute the log.
  const [aBlob, bBlob] = await Promise.all(
    [a, b].map(
      async (c) =>
        (await manager.readResource(c.key, { uri: "account://same" }))
          .contents[0].blob
    )
  );
  assert.notEqual(aBlob, bBlob, "each account must serve its own resource");
  assert.ok(
    serialized.includes(bBlob),
    "B output conversion must read B's resource"
  );
  assert.ok(!serialized.includes(aBlob), "and never A's");
  console.log(
    "PASS: two OAuth grants; distinct same-email identities; B-only resource conversion; selector collision; foreign selector rejected without wire traffic; stable identity after refresh."
  );
} finally {
  await manager.disconnectAllServers();
}

// The lab approval form is deterministic; adapt its interactive consent page
// to the runner's headless auto-consent contract while keeping all OAuth and
// MCP exchanges on the wire.
const { OAuthConformanceTest } = await import("../dist/index.js");
const conformance = await new OAuthConformanceTest({
  serverUrl: base + "/mcp", protocolVersion: "2025-03-26", registrationStrategy: "dcr",
  auth: { mode: "headless" }, redirectUrl: redirect, allowPrivateNetwork: true,
  verification: { listTools: true, timeout: 8_000, profile: { enabled: true } },
  fetchFn: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === new URL(base).origin && url.pathname === "/authorize" && (!init?.method || init.method === "GET")) {
      return post("/authorize/approve", { ...Object.fromEntries(url.searchParams), account_id: accounts[0] }, { redirect: "manual" });
    }
    return fetch(input, init);
  },
}).run();
for (const name of ["verify_profile_shape", "verify_profile_stable", "verify_profile_id_opaque", "verify_profile_stable_after_refresh"]) {
  const step = conformance.steps.find(step => step.step === name);
  assert.equal(step?.status, "passed", `${name}: ${step?.error?.message ?? "did not run"}`);
}
console.log("PASS: live conformance profile shape, stability, opacity heuristic and refresh stability.");
