import { setRequestLocal } from "../../../middleware/request-local";
import { Hono } from "hono";
import type { Context } from "hono";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ revoked: false, grants: vi.fn(async () => "same-project-delegation"), validate: vi.fn() }));
vi.mock("../../service-credential.js", async (original) => ({ ...await original<object>(), hasServiceCredential: () => true }));
vi.mock("../../../middleware/bearer-auth.js", async (original) => ({ ...await original<object>(), bearerAuthMiddleware: async (c: Context, next: () => Promise<void>) => {
  state.validate(); expect(c.get("workosApiKeyValidation")).toBeUndefined(); expect(c.get("workosApiKeyBinding")).toBeUndefined();
  if (state.revoked) return c.json({ refused: true }, 401); await next();
} }));
vi.mock("../../../utils/v1-convex-token.js", async (original) => ({ ...await original<object>(), getBackgroundRunBearerForRequest: async () => state.grants,
  getConvexBearerForRequest: async (c: Context) => { const resolve = c.get("turnAuthorizationBearer") as (() => Promise<string>) | undefined; return resolve ? resolve() : "initial"; },
}));
import { bindPluginOperation } from "../operation-authorization";
import { getConvexBearerForRequest } from "../../../utils/v1-convex-token";
it("revalidates the original API key after App input and refuses revocation before another use", async () => {
  state.revoked=false; state.grants.mockClear(); state.validate.mockClear();
  const owner = { owner: {actorId:"actor",projectId:"project",workspaceId:"workspace",instanceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",generation:1 as const,serverId:"server",bindingId:"binding",placement:"interactive" as const},subject:"key-subject",hostId:"host",hostRevision:"revision",serverIdentity:{kind:"standalone" as const,serverId:"server"} };
  let effect=0;
  const app=new Hono().post("/",async(c)=>{
    c.set("authMethod","workos_api_key");c.set("workosUserId","actor");c.set("mcpjamOrganizationId","org");setRequestLocal(c,"workosApiKeyValidation",{cached:true});setRequestLocal(c,"workosApiKeyBinding",{mcpjamOrganizationId:"org"});
    const bound=await bindPluginOperation(c,owner,{invocationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",origin:"app",params:{name:"review"}},undefined,c.req.raw.signal);
    expect(await getConvexBearerForRequest(c)).toBe("same-project-delegation");effect++;
    state.revoked=true;
    await expect(getConvexBearerForRequest(c)).rejects.toMatchObject({status:403});bound.dispose();
    return c.json({effect});
  });
  expect((await app.request("/",{method:"POST"})).status).toBe(200);expect(effect).toBe(1);expect(state.validate).toHaveBeenCalledTimes(2);expect(state.grants).toHaveBeenCalledOnce();
});
