import { Hono } from "hono";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ verify: undefined as undefined | ((token: string) => Promise<{sub:string;sid?:string;orgId:string}>) }));
vi.mock("../../authkit-jwt.js", () => ({ verifyAuthKitToken: (token: string) => f.verify!(token) }));
import { preparePluginOperation, bindPluginOperation } from "../operation-authorization";
import { turnAuthorizationPart } from "../../../../shared/turn-authorization";
import { turnAuthorizations } from "../../turn-authorization";
const instance = {owner:{actorId:"actor",projectId:"project",workspaceId:"workspace",instanceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",generation:1 as const,serverId:"server",bindingId:"binding",placement:"interactive" as const},subject:"subject",hostId:"host",hostRevision:"revision",serverIdentity:{kind:"standalone" as const,serverId:"server"}};
const op={invocationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",origin:"app" as const,params:{name:"review",arguments:{}}};
const requestId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const live=new AbortController();
let keys:Awaited<ReturnType<typeof generateKeyPair>>;
let metadata:ReturnType<typeof turnAuthorizationPart.parse>|undefined;
const mint=(sub="actor",sid="session",org="org")=>new SignJWT({sid,org_id:org}).setProtectedHeader({alg:"RS256"}).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
beforeEach(async()=>{keys=await generateKeyPair("RS256");f.verify=async(token)=>{const {payload}=await jwtVerify(token,keys.publicKey);return{sub:payload.sub!,sid:String(payload.sid),orgId:String(payload.org_id)};};});
afterEach(()=>{if(metadata)turnAuthorizations.cancelOperation(metadata.data,{subject:"actor",sessionId:"session",organizationId:"org"});metadata=undefined;});
it("rejects changed canonical operation bindings and verified principals before dispatch", async () => {
  const original = await mint(); let effects = 0;
  const target = new Hono().onError((_error, c) => c.json({ refused: true }, 403))
    .use("*", async (c, next) => { const actor = await f.verify!(c.req.header("authorization")!.replace(/^Bearer /, "")); c.set("authMethod", "authkit_jwt"); c.set("workosUserId", actor.sub); await next(); })
    .post("/prepare", async (c) => c.json(await preparePluginOperation(c, instance, op, requestId, live.signal)))
    .post("/bind", async (c) => { const body = await c.req.json(); const claim = await bindPluginOperation(c, body.instance, body.operation, body.authorization, c.req.raw.signal); effects++; claim.dispose(); return c.json({ accepted: true }); });
  metadata = turnAuthorizationPart.parse(await (await target.request("/prepare", { method: "POST", headers: { authorization: `Bearer ${original}` } })).json());
  const { expiresAt: _expires, tokenExpiresAt: _tokenExpires, ...authorization } = metadata.data;
  const variants = [
    { instance: { ...instance, owner: { ...instance.owner, instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } } },
    { instance: { ...instance, owner: { ...instance.owner, generation: 2 } } },
    { instance: { ...instance, hostId: "foreign" } },
    { instance: { ...instance, owner: { ...instance.owner, serverId: "foreign" } } },
    { operation: { ...op, params: { name: "review", arguments: { changed: true } } } },
    { operation: { ...op, origin: "entrypoint" } },
    { token: await mint("foreign") }, { token: await mint("actor", "foreign") }, { token: await mint("actor", "session", "foreign") },
  ];
  for (const changed of variants) {
    const response = await target.request("/bind", { method: "POST", headers: { authorization: `Bearer ${"token" in changed ? changed.token : original}` }, body: JSON.stringify({ instance, operation: op, authorization, ...changed }) });
    expect(response.status).toBe(403);
  }
  expect(effects).toBe(0);
  expect((await target.request("/bind", { method: "POST", headers: { authorization: `Bearer ${original}` }, body: JSON.stringify({ instance, operation: op, authorization }) })).status).toBe(200);
});

it("leaves verified sessions without a renewal sid on the existing short-call path", async () => {
  const token = await mint(); f.verify = async () => ({ sub: "actor", orgId: "org" });
  const app = new Hono().post("/", async (c) => {
    c.set("authMethod", "authkit_jwt"); c.set("workosUserId", "actor");
    return c.json({ renewable: !!(await preparePluginOperation(c, instance, op, requestId, live.signal)) });
  });
  const response = await app.request("/", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(await response.json()).toEqual({ renewable: false });
});
