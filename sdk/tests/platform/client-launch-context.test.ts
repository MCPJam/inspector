/**
 * The DECLARED origin a launch carries — and where it does not go.
 *
 * The platform stamps `source` itself, and everything over the public API is
 * `api`: a CLI run, a GitHub Actions job and an MCP agent are indistinguishable
 * there, because from the server's side all three are API calls. Deriving the
 * difference from `user-agent` was tried and removed as forgeable. So the
 * difference is DECLARED, and these tests pin the three properties that keep
 * that honest:
 *
 *   * it rides HEADERS, so an older deployment ignores it instead of 400ing on
 *     a `.strict()` body it does not know;
 *   * it goes ONLY on the two calls that create a run — a claim on a read is a
 *     claim about nothing;
 *   * it belongs to the HOST PROCESS, set once at construction, so an agent
 *     cannot pick its own badge through a tool argument.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  RUN_LAUNCH_HEADERS,
} from "../../src/platform/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

const ok = () =>
  new Response(JSON.stringify({ runId: "run_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function makeClient(
  fetchMock: FetchMock,
  options: Partial<ConstructorParameters<typeof PlatformApiClient>[0]> = {}
): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_real_credential",
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  });
}

const headersOf = (fetchMock: FetchMock, call = 0): Record<string, string> =>
  fetchMock.mock.calls[call][1].headers as Record<string, string>;

const CLI_LAUNCHER = {
  kind: "cli",
  client: "mcpjam-cli",
  version: "8.2.0",
} as const;

describe("declared launch context", () => {
  it("rides headers on a run launch", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await makeClient(fetchMock, {
      launcher: { ...CLI_LAUNCHER },
      ci: {
        provider: "github_actions",
        commitSha: "a1b2c3",
        branch: "main",
        runId: "42.1",
        job: "evals",
      },
    }).createEvalRun({ projectId: "p1", body: { suiteId: "s1" } });

    const headers = headersOf(fetchMock);
    expect(JSON.parse(headers[RUN_LAUNCH_HEADERS.launcher]!)).toEqual({
      kind: "cli",
      client: "mcpjam-cli",
      version: "8.2.0",
    });
    expect(JSON.parse(headers[RUN_LAUNCH_HEADERS.ci]!)).toMatchObject({
      provider: "github_actions",
      commitSha: "a1b2c3",
      branch: "main",
      runId: "42.1",
      job: "evals",
    });
  });

  it("rides them on a grouped launch too", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await makeClient(fetchMock, {
      launcher: { ...CLI_LAUNCHER },
    }).createEvalRunGroup({ projectId: "p1", body: { suiteId: "s1" } });

    expect(headersOf(fetchMock)[RUN_LAUNCH_HEADERS.launcher]).toBeDefined();
  });

  it("is absent from every call that is not a launch", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    const client = makeClient(fetchMock, { launcher: { ...CLI_LAUNCHER } });

    await client.getMe();
    await client.listEvalSuites({ projectId: "p1" });
    await client.updateEvalSuite({
      projectId: "p1",
      suiteId: "s1",
      body: { name: "x" },
    });

    for (let call = 0; call < 3; call += 1) {
      // A claim about a run's origin, on a request that creates no run, is a
      // claim about nothing — and one more header on every read.
      expect(headersOf(fetchMock, call)).not.toHaveProperty(
        RUN_LAUNCH_HEADERS.launcher,
      );
    }
  });

  it("sends nothing when the process declared nothing", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await makeClient(fetchMock).createEvalRun({
      projectId: "p1",
      body: { suiteId: "s1" },
    });

    const headers = headersOf(fetchMock);
    expect(headers).not.toHaveProperty(RUN_LAUNCH_HEADERS.launcher);
    expect(headers).not.toHaveProperty(RUN_LAUNCH_HEADERS.ci);
  });

  it("drops a kind outside the allowlist rather than refusing to construct", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await makeClient(fetchMock, {
      // `ui` is stamped by the platform; declaring it is restating a value the
      // client does not get to set.
      launcher: { kind: "ui" as never },
    }).createEvalRun({ projectId: "p1", body: { suiteId: "s1" } });

    // A label must never cost someone their run.
    expect(headersOf(fetchMock)).not.toHaveProperty(
      RUN_LAUNCH_HEADERS.launcher,
    );
  });

  it("omits an all-empty CI envelope", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await makeClient(fetchMock, {
      ci: { provider: "   ", branch: "" },
    }).createEvalRun({ projectId: "p1", body: { suiteId: "s1" } });

    // `ciMetadata` present has to mean "this run came from CI", not "the
    // caller passed the option".
    expect(headersOf(fetchMock)).not.toHaveProperty(RUN_LAUNCH_HEADERS.ci);
  });

  it("cannot be overridden through extraHeaders", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await makeClient(fetchMock, {
      launcher: { ...CLI_LAUNCHER },
      extraHeaders: {
        [RUN_LAUNCH_HEADERS.launcher]: JSON.stringify({ kind: "mcp" }),
      },
    }).createEvalRun({ projectId: "p1", body: { suiteId: "s1" } });

    // `extraHeaders` is the edge-authenticator door. An edge credential must
    // not be able to relabel a run's origin on the way past.
    expect(
      JSON.parse(headersOf(fetchMock)[RUN_LAUNCH_HEADERS.launcher]!).kind,
    ).toBe("cli");
  });
});
