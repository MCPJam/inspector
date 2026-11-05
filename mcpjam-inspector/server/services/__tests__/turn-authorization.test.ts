import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import { verifyAuthKitToken, type AuthKitVerifyDeps } from "../authkit-jwt.js";
import { RevokedSessionCache, setRevokedSessionCacheForTests } from "../revoked-session-cache.js";
import { TurnAuthorizationRegistry } from "../turn-authorization.js";

const owner = { subject: "member", sessionId: "session", organizationId: "org" };
const scope = { projectId: "project", chatSessionId: "chat", turnId: "turn", requestId: "f56e90a1-dc58-443e-85b0-14677744b9b3" };
const issuer = "https://login.mcpjam.com";
const clientId = "client_01K4C1TVPBE7JTBFQJF9SDW9P9";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let deps: AuthKitVerifyDeps;
let cache: RevokedSessionCache;
const leases: Array<{ dispose(): void }> = [];
async function token(claims: Partial<typeof owner> = {}, life = "5m") {
  const identity = { ...owner, ...claims };
  return new SignJWT({ sid: identity.sessionId, org_id: identity.organizationId })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setSubject(identity.subject)
    .setAudience(clientId).setIssuedAt().setExpirationTime(life).sign(keys.privateKey);
}
function registry() { return new TurnAuthorizationRegistry((value) => verifyAuthKitToken(value, deps)); }
beforeEach(async () => {
  vi.useFakeTimers();
  keys = await generateKeyPair("RS256");
  deps = { clientId, resolveKey: (candidate) => candidate === issuer ? keys.publicKey : null };
  cache = new RevokedSessionCache({ fetchPage: async () => ({ sessions: [], cursor: null, isDone: true, watermark: Date.now() }) });
  await cache.scan(); setRevokedSessionCacheForTests(cache);
});
afterEach(() => { for (const lease of leases.splice(0)) lease.dispose(); setRevokedSessionCacheForTests(null); vi.useRealTimers(); });
it("uses a fresh signed JWT after the original expires without changing the turn owner", async () => {
  const original = await token(); const store = registry(); const lease = store.create(owner, scope, original); leases.push(lease);
  expect(await lease.getAuthorization()).toBe(`Bearer ${original}`);
  await vi.advanceTimersByTimeAsync(4 * 60_000); await cache.scan();
  const renewed = await token(); await store.renew(lease.data, owner, renewed);
  await vi.advanceTimersByTimeAsync(2 * 60_000); await cache.scan();
  await expect(verifyAuthKitToken(original, deps)).rejects.toThrow();
  expect(await lease.getAuthorization()).toBe(`Bearer ${renewed}`);
  cache.markRevokedLocally(owner.sessionId);
  await expect(lease.getAuthorization()).rejects.toMatchObject({ code: "SESSION_REVOKED" });
  await expect(store.renew(lease.data, owner, await token())).rejects.toMatchObject({ code: "SESSION_REVOKED" });
});
it.each([
  { subject: "foreign" }, { sessionId: "foreign" }, { organizationId: "foreign" },
])("refuses another verified identity %j without replacing the token", async (changed) => {
  const original = await token(); const store = registry(); const lease = store.create(owner, scope, original); leases.push(lease);
  await expect(store.renew(lease.data, { ...owner, ...changed }, await token(changed))).rejects.toMatchObject({ status: 401 });
  await expect(store.renew(lease.data, owner, await token(changed))).rejects.toThrow();
  expect(await lease.getAuthorization()).toBe(`Bearer ${original}`);
});
it.each(["projectId", "chatSessionId", "turnId", "requestId", "handle"] as const)("refuses changed %s", async (field) => {
  const original = await token(); const store = registry(); const lease = store.create(owner, scope, original); leases.push(lease);
  await expect(store.renew({ ...lease.data, [field]: "foreign" }, owner, original)).rejects.toMatchObject({ status: 401 });
});
it("ends updates on cancellation and keeps only verified cleanup authority after disposal", async () => {
  const original = await token(); const store = registry(); const abort = new AbortController();
  const lease = store.create(owner, scope, original, abort.signal); leases.push(lease);
  abort.abort(); await expect(lease.getAuthorization()).rejects.toMatchObject({ status: 401 });
  await expect(store.renew(lease.data, owner, original)).rejects.toMatchObject({ status: 401 });
  lease.dispose(); await expect(lease.getAuthorization()).rejects.toMatchObject({ status: 401 });
  expect(await lease.getCleanupAuthorization()).toBe(`Bearer ${original}`);
  cache.markRevokedLocally(owner.sessionId); await expect(lease.getCleanupAuthorization()).rejects.toMatchObject({ code: "SESSION_REVOKED" });
});
it.each(["dispose", "abort"])("rechecks %s after a pending verifier completes", async (kind) => {
  let resolve!: (value: { sub: string; sid: string; orgId: string }) => void;
  const store = new TurnAuthorizationRegistry(() => new Promise((done) => { resolve = done; }));
  const abort = new AbortController();
  const lease = store.create(owner, scope, await token(), abort.signal); leases.push(lease);
  const pending = lease.getAuthorization(); if (kind === "dispose") lease.dispose(); else abort.abort(); resolve({ sub: owner.subject, sid: owner.sessionId, orgId: owner.organizationId });
  await expect(pending).rejects.toMatchObject({ status: 401 });
});
it("rejects invalid signatures and expired replacement JWTs", async () => {
  const original = await token(); const store = registry(); const lease = store.create(owner, scope, original); leases.push(lease);
  await expect(store.renew(lease.data, owner, original.slice(0, -8) + "invalid")).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(6 * 60_000); await cache.scan();
  await expect(store.renew(lease.data, owner, original)).rejects.toThrow();
});
it("bounds both scope and retention", async () => {
  const store = registry(); const original = await token();
  expect(() => store.create(owner, { ...scope, chatSessionId: "x".repeat(257) }, original)).toThrow();
  const lease = store.create(owner, scope, original); leases.push(lease);
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
  await expect(store.renew(lease.data, owner, await token())).rejects.toMatchObject({ status: 401 });
  await expect(lease.getAuthorization()).rejects.toMatchObject({ status: 401 });
});

it("bounds active records per actor", async () => {
  const store = registry(); const original = await token();
  for (let i = 0; i < 8; i++) leases.push(store.create(owner, { ...scope, turnId: String(i) }, original));
  expect(() => store.create(owner, scope, original)).toThrow("Too many active turns");
});

it("waits for the first renewal when a turn starts near JWT expiry without returning an expired token", async () => {
  const original = await token({}, "5s"); const store = registry(); const lease = store.create(owner, scope, original); leases.push(lease);
  const pending = lease.getAuthorization();
  await vi.advanceTimersByTimeAsync(6000); await cache.scan();
  const fresh = await token(); await store.renew(lease.data, owner, fresh);
  expect(await pending).toBe(`Bearer ${fresh}`);
  expect((decodeJwt(original).exp ?? Infinity) * 1000).toBeLessThan(Date.now());
});
