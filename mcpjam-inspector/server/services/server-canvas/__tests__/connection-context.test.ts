import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CACHED_CONTEXTS,
  hostedContextHash,
  rememberHostedContext,
  resetHostedContextsForTests,
} from "../connection-context.js";

const KEY = { projectId: "prj_1", serverId: "srv_1", actorId: "user_a" };

describe("hosted context cache", () => {
  beforeEach(() => resetHostedContextsForTests());

  it("keeps the newest hash per project server and actor, and stays bounded", () => {
    rememberHostedContext(KEY, "ctx_old");
    rememberHostedContext(KEY, "ctx_new");
    expect(hostedContextHash(KEY)).toBe("ctx_new");
    expect(hostedContextHash({ ...KEY, projectId: "prj_2" })).toBeUndefined();
    for (let index = 0; index < MAX_CACHED_CONTEXTS; index += 1)
      rememberHostedContext({ ...KEY, serverId: `srv_${index + 2}` }, "ctx");
    expect(hostedContextHash(KEY)).toBeUndefined();
  });

  it("never answers one actor with another actor's context", () => {
    rememberHostedContext(KEY, "ctx_a");
    expect(hostedContextHash({ ...KEY, actorId: "user_b" })).toBeUndefined();
    rememberHostedContext({ ...KEY, actorId: "user_b" }, "ctx_b");
    expect(hostedContextHash(KEY)).toBe("ctx_a");
    expect(hostedContextHash({ ...KEY, actorId: "user_b" })).toBe("ctx_b");
  });
});
