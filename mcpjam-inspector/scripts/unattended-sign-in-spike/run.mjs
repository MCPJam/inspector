import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright";
import { currentStep, startIssuer, totp } from "./controlled-issuer.mjs";
import { signIn } from "./sign-in-worker.mjs";

// RFC 6238 Appendix B, independently published SHA-1 vectors.
const referenceKey = Buffer.from("12345678901234567890");
assert.equal(totp(referenceKey, Math.floor(59 / 30), 8), "94287082");
assert.equal(totp(referenceKey, Math.floor(1111111109 / 30), 8), "07081804");
assert.equal(totp(referenceKey, Math.floor(59 / 30)), "287082");

const password = randomBytes(32).toString("base64url");
const seed = randomBytes(20);
const project = "renewal-spike";
const seat = "controlled-review-seat";
const ttlMs = 3000;
const idp = await startIssuer({ password, seed, seat, ttlMs });
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const reads = { password: 0, code: 0 };
  const credentials = {
    password: async () => {
      reads.password++;
      return password;
    },
    code: async () => {
      reads.code++;
      const remaining = 30000 - (Date.now() % 30000);
      if (remaining < 1500) await wait(remaining + 10);
      return totp(seed, currentStep());
    },
  };
  const binding = { project, seat, origin: idp.origin };
  const run = (request = { project, seat }) =>
    signIn({ page, binding, request, credentials });
  const marker = "HARN129-" + randomUUID().slice(0, 8);
  const echo = async (text) => {
    const response = await context.request.post(idp.origin + "/mcp", {
      headers: { accept: "application/json, text/event-stream" },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text } },
      },
    });
    const status = response.status();
    if (status !== 200) return { status };
    const answer = await response.json();
    return { status, text: answer.result?.content?.[0]?.text };
  };
  // Admission checks must fail before touching the test credentials.
  assert.equal(
    (await run({ project: "other", seat })).status,
    "connection_mismatch",
  );
  assert.equal((await run()).status, "unexpected_page");
  await page.goto(idp.origin + "/login");
  await page.locator("form").evaluate((form) => {
    form.action = "https://wrong-origin.invalid/password";
  });
  assert.equal((await run()).status, "unexpected_page");
  assert.deepEqual(reads, { password: 0, code: 0 });
  assert.deepEqual(await echo(marker + "-cold"), { status: 401 });
  await page.goto(idp.origin + "/home");
  assert.equal((await run()).status, "signed_in");
  const first = await echo(marker + "-cold");
  assert.deepEqual(first, { status: 200, text: "echo: " + marker + "-cold" });
  // The cookie stays in the browser. The issuer expires it server-side.
  // Wait for a new TOTP counter as well: the fixture rejects reused counters.
  await wait(Math.max(ttlMs + 100, 30010 - (Date.now() % 30000)));
  const expired = await echo(marker + "-renewed");
  assert.equal(expired.status, 401);
  assert.equal(idp.evidence.toolCalls.length, 1);
  await page.goto(idp.origin + "/home");
  assert.equal((await run()).status, "signed_in");
  const resumed = await echo(marker + "-renewed");
  assert.deepEqual(resumed, {
    status: 200,
    text: "echo: " + marker + "-renewed",
  });
  assert.deepEqual(idp.evidence.toolCalls, [
    marker + "-cold",
    marker + "-renewed",
  ]);
  assert.equal(new Set(idp.evidence.acceptedSteps).size, 2);
  // A human challenge returns to the owner without issuing another factor.
  idp.requirePerson();
  await page.goto(idp.origin + "/login");
  assert.equal((await run()).status, "needs_person");
  assert.deepEqual(reads, { password: 3, code: 2 });
  const rejected = await browser.newContext({ serviceWorkers: "block" });
  const rejectedPage = await rejected.newPage();
  await rejectedPage.goto(idp.origin + "/login");
  const denied = await signIn({
    page: rejectedPage,
    binding,
    request: { project, seat },
    credentials: {
      password: async () => "fixture-invalid",
      code: credentials.code,
    },
  });
  assert.equal(denied.status, "password_rejected");
  assert.equal(rejectedPage.isClosed(), true);
  assert.equal(reads.code, 2);
  process.stdout.write(
    JSON.stringify(
      {
        browser: "local Chromium",
        provider: "in-memory test identity",
        run: marker,
        cold: { before: 401, after: first },
        expired: { before: expired.status, after: resumed },
        acceptedDistinctTotpCounters: 2,
        successfulToolCalls: idp.evidence.toolCalls.length,
        unexpectedPage: "refused before credential read",
        wrongProject: "refused before credential read",
        crossOriginForm: "refused before credential read",
        badPassword: "closed private context",
        humanChallenge: "needs_person",
        at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await idp.close();
  }
}
