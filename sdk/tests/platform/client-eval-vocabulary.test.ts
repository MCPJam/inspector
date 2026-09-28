/**
 * `evalVocabulary` — the client's half of the `x-mcpjam-eval-vocabulary`
 * negotiation.
 *
 * Three things are pinned. The header is sent on EVERY request when the client
 * opted in, and on none when it did not (vocabulary 1 is the ABSENCE of the
 * header, byte-for-byte today's contract — never the string "1"). An edge
 * credential cannot change which vocabulary a body is read in. And
 * `withEvalVocabulary` derives a sibling that differs in exactly that one
 * thing, leaving the original client untouched — the step from "asked the
 * deployment what it speaks" to "speaks it" with the credential it already
 * holds.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EVAL_VOCABULARY_HEADER,
  PlatformApiClient,
  RUN_LAUNCH_HEADERS,
} from "../../src/platform/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

const ok = () =>
  new Response(JSON.stringify({ id: "u_1", items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function makeClient(
  fetchMock: FetchMock,
  options: {
    evalVocabulary?: 1 | 2;
    extraHeaders?: Record<string, string>;
  } = {}
): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_real_credential",
    fetch: fetchMock as unknown as typeof fetch,
    launcher: { kind: "cli", client: "mcpjam-cli", version: "0.0.0" },
    ...options,
  });
}

const headersOf = (fetchMock: FetchMock, call = 0): Record<string, string> =>
  fetchMock.mock.calls[call][1].headers as Record<string, string>;

describe("PlatformApiClient evalVocabulary", () => {
  it("sends nothing by default — vocabulary 1 is the absence of the header", async () => {
    const fetchMock = vi.fn().mockImplementation(() => ok());
    await makeClient(fetchMock).getMe();
    expect(EVAL_VOCABULARY_HEADER in headersOf(fetchMock)).toBe(false);

    const explicit = vi.fn().mockImplementation(() => ok());
    await makeClient(explicit, { evalVocabulary: 1 }).getMe();
    expect(EVAL_VOCABULARY_HEADER in headersOf(explicit)).toBe(false);
  });

  it("sends `2` on every request once opted in, not only the eval ones", async () => {
    const fetchMock = vi.fn().mockImplementation(() => ok());
    const client = makeClient(fetchMock, { evalVocabulary: 2 });
    await client.getMe();
    await client.listProjects();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock, 0)[EVAL_VOCABULARY_HEADER]).toBe("2");
    expect(headersOf(fetchMock, 1)[EVAL_VOCABULARY_HEADER]).toBe("2");
  });

  it("cannot be set or cleared through extraHeaders", async () => {
    // The edge-authenticator door must not decide which vocabulary a body is
    // read in: a proxy that injected `2` would make a vocabulary-1 body mean
    // something else, and one that injected `1` against an opted-in client
    // would have the server refuse every canonical field it sends.
    const injected = vi.fn().mockImplementation(() => ok());
    await makeClient(injected, {
      extraHeaders: { "X-MCPJAM-EVAL-VOCABULARY": "2" },
    }).getMe();
    expect(EVAL_VOCABULARY_HEADER in headersOf(injected)).toBe(false);

    const cleared = vi.fn().mockImplementation(() => ok());
    await makeClient(cleared, {
      evalVocabulary: 2,
      extraHeaders: { "x-mcpjam-eval-vocabulary": "1" },
    }).getMe();
    expect(headersOf(cleared)[EVAL_VOCABULARY_HEADER]).toBe("2");
  });

  it("withEvalVocabulary derives a sibling and leaves the original alone", async () => {
    const fetchMock = vi.fn().mockImplementation(() => ok());
    const base = makeClient(fetchMock, {
      extraHeaders: { "cf-access-client-id": "id.access" },
    });
    const speaking = base.withEvalVocabulary(2);
    expect(speaking).not.toBe(base);
    // Same vocabulary → the same client; nothing to derive.
    expect(base.withEvalVocabulary(1)).toBe(base);
    expect(speaking.withEvalVocabulary(2)).toBe(speaking);

    await speaking.getMe();
    await base.getMe();
    const derived = headersOf(fetchMock, 0);
    const original = headersOf(fetchMock, 1);
    expect(derived[EVAL_VOCABULARY_HEADER]).toBe("2");
    expect(EVAL_VOCABULARY_HEADER in original).toBe(false);
    // Everything else the client owns rides along unchanged: the credential,
    // the edge headers, the user agent.
    expect(derived.authorization).toBe(original.authorization);
    expect(derived["cf-access-client-id"]).toBe("id.access");
    expect(derived["user-agent"]).toBe(original["user-agent"]);
  });

  it("keeps the launch declaration on a derived client", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify({ runId: "r1", status: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
    );
    const speaking = makeClient(fetchMock).withEvalVocabulary(2);
    await speaking.createEvalRun({ projectId: "p1", body: { suiteId: "s1" } });
    const headers = headersOf(fetchMock);
    expect(headers[EVAL_VOCABULARY_HEADER]).toBe("2");
    expect(headers[RUN_LAUNCH_HEADERS.launcher]).toContain('"kind":"cli"');
  });
});
