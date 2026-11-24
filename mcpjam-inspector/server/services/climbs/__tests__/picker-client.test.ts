import { afterEach, describe, expect, it } from "vitest";
import { registerSelfFetch } from "../../../utils/self-app.js";
import { buildPickerPlatformClient } from "../picker-client.js";
import { pickerStepHeaders } from "../picker-headers.js";

describe("the platform client of a picker step", () => {
  afterEach(() => registerSelfFetch(async () => new Response("not registered")));

  it("calls the server's own /api/v1 as the person, with the step's marker on every call", async () => {
    const seen: Request[] = [];
    registerSelfFetch(async (request) => {
      seen.push(request);
      return Response.json({ items: [] });
    });
    let token = "first";
    const client = buildPickerPlatformClient(async () => token, { generation: 7, chatSessionId: "chat_9" });
    await client.listProjects();
    token = "second";
    await client.listProjects();
    expect(new URL(seen[0]!.url).pathname).toBe("/api/v1/projects");
    // The bearer is read for each call, so a long step is not held to one token.
    expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer first", "Bearer second"]);
    expect(seen[0]!.headers.get("x-mcpjam-picker-step")).toBe("7");
    expect(seen[0]!.headers.get("x-mcpjam-picker-chat-session")).toBe("chat_9");
  });

  it("keys the round route's call by the attempt, and no other call", async () => {
    const seen: Request[] = [];
    registerSelfFetch(async (request) => {
      seen.push(request);
      return Response.json({});
    });
    const client = buildPickerPlatformClient(async () => "t", { generation: 7 }, "climb-step:c:7");
    await client.submitClimbRound({ projectId: "p", climbId: "c", serverId: "s" });
    await client.getClimb({ projectId: "p", climbId: "c" });
    expect(seen.map((request) => request.headers.get("idempotency-key"))).toEqual(["climb-step:c:7", null]);
  });

  it("sends no session header when the transcript was not stored", () => {
    expect(pickerStepHeaders({ generation: 2 })).toEqual({ "x-mcpjam-picker-step": "2" });
  });

  it("says what failed when the server's own dispatch is not registered", async () => {
    registerSelfFetch(undefined as never);
    const client = buildPickerPlatformClient(async () => "t", { generation: 1 });
    await expect(client.listProjects()).rejects.toThrow(/dispatch is not registered/);
  });
});
