import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  sendChatMessageOperation,
} from "../../src/platform/index.js";

/**
 * `hostId` reaches the WIRE on `send_chat_message`.
 *
 * Validating past the operation's input schema is NOT the property. The client
 * builds the request body key by key — deliberately, so a caller's stray field
 * cannot 400 a strict route — which means a field the schema accepts but the
 * `execute` never forwards is dropped in silence, with a 200 to show for it.
 * That is exactly what happened in #4598, on this same operation.
 *
 * So these assert the two halves separately and then the join: the schema
 * accepts it, the client puts it in the body, and driving the OPERATION end to
 * end lands it on the request. Removing the forward from `execute` fails the
 * third even though the first two still pass.
 */

type FetchMock = ReturnType<typeof vi.fn>;

const HOST = "host_claude_code";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A turn response shaped like the route's — enough for the operation to return. */
const TURN_RESULT = {
  sessionId: "cs_1",
  turnId: "turn_1",
  projectId: "proj_a",
  reply: "ok",
  engine: "harness:claude-code",
  hostId: HOST,
  persisted: { outcome: "saved" },
  origin: "api",
};

function makeClient(fetchMock: FetchMock): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test_token",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

function bodyOf(fetchMock: FetchMock, call = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[call]!;
  return JSON.parse(String((init as RequestInit).body));
}

describe("send_chat_message host targeting", () => {
  it("accepts hostId on the operation's input schema", () => {
    const parsed = sendChatMessageOperation.inputSchema.parse({
      idempotencyKey: "k1",
      message: "hi",
      hostId: HOST,
    });
    expect(parsed).toMatchObject({ hostId: HOST });
  });

  it("puts hostId in the request BODY, not just past validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TURN_RESULT));
    await makeClient(fetchMock).sendChatMessage({
      idempotencyKey: "k1",
      message: "hi",
      projectId: "proj_a",
      modelId: "anthropic/claude-sonnet-5",
      hostId: HOST,
      toolMode: "auto",
    });

    const body = bodyOf(fetchMock);
    expect(body.hostId).toBe(HOST);
    // The route's schema is strict, so the body must carry nothing else new.
    expect(Object.keys(body).sort()).toEqual(
      [
        "hostId",
        "idempotencyKey",
        "message",
        "modelId",
        "projectId",
        "toolMode",
      ].sort()
    );
  });

  it("carries hostId all the way through the OPERATION to the wire", async () => {
    // The end-to-end join. `execute` forwards field by field, so this is the
    // assertion that catches a schema addition nobody wired into the client
    // call — a 200 with the field silently stripped.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TURN_RESULT));
    const client = makeClient(fetchMock);
    const result = await sendChatMessageOperation.execute(
      {
        idempotencyKey: "k1",
        message: "hi",
        sessionId: "cs_1",
        hostId: HOST,
      },
      { client, signal: undefined, onScopeResolved: () => {} } as never
    );

    expect(bodyOf(fetchMock).hostId).toBe(HOST);
    // And the engine the route reports comes back on the typed result, so a
    // caller can tell a harness turn from an emulated one without guessing.
    expect(result.engine).toBe("harness:claude-code");
    expect(result.hostId).toBe(HOST);
  });

  it("omits hostId entirely when the caller sends none", async () => {
    // Non-vacuity for the assertions above: the same code path with no hostId
    // must not put the key on the wire at all, so the checks are observing the
    // field rather than a constant.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TURN_RESULT));
    await sendChatMessageOperation.execute(
      { idempotencyKey: "k1", message: "hi", sessionId: "cs_1" },
      {
        client: makeClient(fetchMock),
        signal: undefined,
        onScopeResolved: () => {},
      } as never
    );

    expect(bodyOf(fetchMock)).not.toHaveProperty("hostId");
  });
});
