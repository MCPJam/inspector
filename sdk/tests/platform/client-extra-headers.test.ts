/**
 * `extraHeaders` — the edge-authenticator door, and the lock on it.
 *
 * The point of these tests is not that a custom header arrives. It is that a
 * custom header can NEVER become the credential, the retry key, or the body's
 * description, however it is spelled. The CLI rejects those names at its own
 * boundary, but the CLI is not the only caller of this client, so the transport
 * has to hold the line by itself.
 */
import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

const ok = () =>
  new Response(JSON.stringify({ id: "u_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function makeClient(
  fetchMock: FetchMock,
  extraHeaders?: Record<string, string>
): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_real_credential",
    fetch: fetchMock as unknown as typeof fetch,
    ...(extraHeaders ? { extraHeaders } : {}),
  });
}

const headersOf = (fetchMock: FetchMock): Record<string, string> =>
  fetchMock.mock.calls[0][1].headers as Record<string, string>;

describe("PlatformApiClient extraHeaders", () => {
  it("sends the extra headers alongside the credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "shhh",
    }).getMe();

    const headers = headersOf(fetchMock);
    expect(headers["cf-access-client-id"]).toBe("id.access");
    expect(headers["cf-access-client-secret"]).toBe("shhh");
    expect(headers.authorization).toBe("Bearer sk_real_credential");
  });

  it("cannot replace the credential, whatever case it uses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      Authorization: "Bearer sk_attacker_token",
      AUTHORIZATION: "Bearer sk_attacker_token_2",
    }).getMe();

    const headers = headersOf(fetchMock);
    expect(headers.authorization).toBe("Bearer sk_real_credential");
    // Not merely overridden — the attacker's value is nowhere on the request.
    expect(JSON.stringify(headers)).not.toContain("sk_attacker_token");
  });

  it("cannot forge a second spelling of a header it already set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, { "CF-Access-Client-Id": "one" }).getMe();

    // Lower-cased at construction, so a caller's `Name` and the client's
    // `name` can never both reach fetch as separate keys.
    const names = Object.keys(headersOf(fetchMock));
    expect(names).toEqual(names.map((n) => n.toLowerCase()));
    expect(new Set(names).size).toBe(names.length);
  });

  it("cannot replace the idempotency key on a write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      "Idempotency-Key": "attacker-key",
    }).createProject({ body: { name: "p" } }, { idempotencyKey: "caller-key" });

    expect(headersOf(fetchMock)["idempotency-key"]).toBe("caller-key");
  });

  it("cannot mislabel a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, { "Content-Type": "text/plain" }).createProject({
      body: { name: "p" },
    });

    expect(headersOf(fetchMock)["content-type"]).toBe("application/json");
  });

  it("leaves content-type alone on a request that HAS no body", async () => {
    // Nothing to mislabel, so nothing is defended: the client only claims
    // `content-type` when it is describing a body it actually sent. Pinned so
    // the asymmetry is a decision on record rather than a surprise later.
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, { "Content-Type": "text/plain" }).getMe();

    expect(headersOf(fetchMock)["content-type"]).toBe("text/plain");
  });

  it("changes nothing when no extra headers are given", async () => {
    const withNone = vi.fn().mockResolvedValue(ok());
    const withEmpty = vi.fn().mockResolvedValue(ok());
    await makeClient(withNone).getMe();
    await makeClient(withEmpty, {}).getMe();

    expect(headersOf(withEmpty)).toEqual(headersOf(withNone));
  });
});
