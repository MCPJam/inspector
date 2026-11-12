import { mergeConnectionToolsets } from "@mcpjam/sdk";
import { describe, expect, it } from "vitest";
import type { ConvexBatchAuthorizeSuccess } from "../../routes/web/auth.js";
import { WebRouteError } from "../../routes/web/errors.js";
import {
  createAiSdkEvalTraceContext,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../../services/evals/eval-trace-capture.js";
import { accountSetGroup } from "../oauth-account-sets.js";

const LIVE = "a".repeat(32);
const DUMMY = "b".repeat(32);

function authorized(
  overrides: Partial<ConvexBatchAuthorizeSuccess> = {},
): ConvexBatchAuthorizeSuccess {
  return {
    ok: true,
    role: "member",
    accessLevel: "project_member",
    permissions: { chatOnly: false },
    serverConfig: {
      transportType: "http",
      url: "https://asana.example/mcp",
      useOAuth: true,
    } as ConvexBatchAuthorizeSuccess["serverConfig"],
    oauthAccountSet: "applied",
    oauthAccessToken: "token-dummy",
    oauthConnections: [
      {
        connectionId: DUMMY,
        label: "Dummy",
        isDefault: false,
        accessToken: "token-dummy",
      },
    ],
    ...overrides,
  };
}

function group(
  set: string[],
  auth: ConvexBatchAuthorizeSuccess = authorized(),
) {
  return accountSetGroup({
    serverId: "asana",
    serverName: "Asana",
    auth,
    set,
  });
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebRouteError);
    expect((error as WebRouteError).status).toBe(403);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("accountSetGroup", () => {
  it("gives a chosen non-default account the bare server key", () => {
    expect(group([DUMMY])).toEqual([
      {
        serverId: "asana",
        connectionId: DUMMY,
        key: "asana",
        label: "Dummy",
        isDefault: true,
      },
    ]);
  });

  it("keeps the person's default as the base when it is chosen", () => {
    const auth = authorized({
      oauthConnections: [
        {
          connectionId: DUMMY,
          label: "Dummy",
          isDefault: false,
          accessToken: "token-dummy",
        },
        {
          connectionId: LIVE,
          label: "Live",
          isDefault: true,
          accessToken: "token-live",
        },
      ],
    });
    expect(
      group([DUMMY, LIVE], auth)?.map(({ connectionId, key }) => ({
        connectionId,
        key,
      })),
    ).toEqual([
      { connectionId: DUMMY, key: `asana#${DUMMY}` },
      { connectionId: LIVE, key: "asana" },
    ]);
  });

  it("names accounts without an email and drops the profile email", () => {
    const auth = authorized({
      oauthConnections: [
        {
          connectionId: DUMMY,
          isDefault: false,
          accessToken: "token-dummy",
          profile: { id: "gid-1", email: "sophie@example.com", name: "Sophie" },
        },
      ],
    });
    expect(group([DUMMY], auth)?.[0]).toMatchObject({
      label: "Sophie",
      profile: { id: "gid-1", name: "Sophie" },
    });
    expect(JSON.stringify(group([DUMMY], auth))).not.toContain("@");
  });

  it("refuses an account that needs reconnecting, by name", () => {
    const auth = authorized({
      oauthConnections: [
        {
          connectionId: DUMMY,
          label: "Dummy",
          isDefault: false,
          accessToken: "token-dummy",
          needsReauth: true,
        },
      ],
    });
    expect(refusal(() => group([DUMMY], auth))).toBe(
      "Asana Dummy needs reconnect. Reconnect it in Authorization, or choose another account in the suite's settings.",
    );
  });

  it("refuses when a chosen account was removed", () => {
    expect(
      refusal(() => group([DUMMY], authorized({ oauthConnections: [] }))),
    ).toContain("was removed");
  });

  it("refuses a token the backend sent without honoring the set", () => {
    expect(
      refusal(() =>
        group([DUMMY], authorized({ oauthAccountSet: undefined })),
      ),
    ).toContain("couldn't confirm which Asana account");
  });

  it("leaves a shared server on its project connection", () => {
    expect(
      group([DUMMY], authorized({ oauthAccountSet: "shared" })),
    ).toBeUndefined();
  });
});

describe("a run with only Dummy chosen", () => {
  it("routes every call to Dummy and records it on the tool span", async () => {
    const connections = group([DUMMY])!;
    const calls: string[] = [];
    const merged = mergeConnectionToolsets(
      {
        asana: {
          delete_task: {
            description: "Delete a task",
            inputSchema: { type: "object", properties: {} },
            execute: async () => {
              calls.push("asana");
              return { content: [] };
            },
          } as never,
        },
      },
      { asana: connections },
      { snapshot: new Map(connections.map((c) => [c.connectionId, c.key])) },
    );
    const ctx = createAiSdkEvalTraceContext(Date.now());
    registerAiSdkPrepareStep(ctx, 0);
    const traced = wrapToolSetForEvalTrace(merged, ctx) as Record<
      string,
      { execute: (input: unknown, options: { toolCallId: string }) => unknown }
    >;

    await traced.delete_task.execute({}, { toolCallId: "call-1" });

    expect(calls).toEqual(["asana"]);
    expect(
      ctx.recordedSpans.find((span) => span.id === "tool-call-1"),
    ).toMatchObject({ serverId: "asana", connectionId: DUMMY });
  });
});
