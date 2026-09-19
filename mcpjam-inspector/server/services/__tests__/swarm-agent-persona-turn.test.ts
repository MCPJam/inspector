import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swarmPersonaNextTurn } from "../swarm-agent";

/**
 * The backend mints a per-turn billing key from the wire identity and refuses
 * the turn when it cannot (`Invalid journey session identity`), so an identity
 * this call leaves out kills the session before its first message rather than
 * costing a fee. Two fields carry that identity:
 *
 *   - `sessionIdx`, validated with `Number.isInteger`, so an omitted one is
 *     rejected exactly like a malformed one — and session 0 is the common case.
 *   - `targetId`, because two environments may resolve to the SAME host, and
 *     matching on `hostId` alone then finds two targets and is refused as
 *     ambiguous.
 */

type FetchMock = ReturnType<typeof stubTurnResponse>;

function stubTurnResponse() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, message: "next persona turn" }),
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function sentBody(fetchMock: FetchMock): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

async function takeTurn(
  overrides: Partial<Parameters<typeof swarmPersonaNextTurn>[2]> = {},
) {
  const fetchMock = stubTurnResponse();
  await swarmPersonaNextTurn("https://convex.test", "tok", {
    projectId: "p1",
    runId: "r1",
    hostId: "h1",
    targetId: "env:e1",
    sessionIdx: 0,
    transcriptSoFar: [],
    ...overrides,
  });
  return sentBody(fetchMock);
}

describe("swarmPersonaNextTurn: wire identity", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("sends session 0 rather than dropping a falsy index", async () => {
    expect(await takeTurn({ sessionIdx: 0 })).toMatchObject({ sessionIdx: 0 });
  });

  it("sends the target id so a host shared by two targets stays unambiguous", async () => {
    expect(await takeTurn({ targetId: "env:e2" })).toMatchObject({
      targetId: "env:e2",
    });
  });

  it("omits the target id on a legacy run that has none", async () => {
    expect(await takeTurn({ targetId: undefined })).not.toHaveProperty(
      "targetId",
    );
  });
});
