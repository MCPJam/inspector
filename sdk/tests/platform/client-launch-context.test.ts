/**
 * `launcher` and `ci` — the declared half of run origin, and its blast radius.
 *
 * The whole reason these are client-construction options rather than
 * per-operation parameters is ownership: the HOST PROCESS knows what it is (the
 * CLI, an Action running the CLI, the hosted MCP worker), and a per-operation
 * argument would end up on `run_eval_suite`'s input schema, where a model could
 * write it. So the tests are about where the labels appear and, more
 * importantly, where they DON'T.
 */
import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

const ok = (body: unknown = { runId: "run_1" }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function makeClient(
  fetchMock: FetchMock,
  options: {
    launcher?: Parameters<typeof PlatformApiClient>[0]["launcher"];
    ci?: Parameters<typeof PlatformApiClient>[0]["ci"];
  } = {}
): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  });
}

const headersOf = (fetchMock: FetchMock, call = 0): Record<string, string> =>
  fetchMock.mock.calls[call][1].headers as Record<string, string>;

describe("launch-context headers", () => {
  it("sends both headers on a single eval-run launch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      launcher: { kind: "cli", client: "mcpjam-cli", version: "8.1.0" },
      ci: { provider: "github_actions", commitSha: "abc123", runId: "42" },
    }).createEvalRun({ projectId: "p_1", body: { suiteId: "s_1" } });

    const headers = headersOf(fetchMock);
    expect(JSON.parse(headers["x-mcpjam-launcher"])).toEqual({
      kind: "cli",
      client: "mcpjam-cli",
      version: "8.1.0",
    });
    expect(JSON.parse(headers["x-mcpjam-ci"])).toEqual({
      provider: "github_actions",
      commitSha: "abc123",
      runId: "42",
    });
  });

  it("sends both headers on a run-group launch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ runs: [] }));
    await makeClient(fetchMock, {
      launcher: { kind: "github_action" },
      ci: { commitSha: "abc123" },
    }).createEvalRunGroup({ projectId: "p_1", body: { suiteId: "s_1" } });

    const headers = headersOf(fetchMock);
    expect(JSON.parse(headers["x-mcpjam-launcher"]).kind).toBe("github_action");
    expect(JSON.parse(headers["x-mcpjam-ci"]).commitSha).toBe("abc123");
  });

  it("sends them NOWHERE else, even when the client is configured with both", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => ok({ id: "u_1", items: [], nextCursor: null }));
    const client = makeClient(fetchMock, {
      launcher: { kind: "cli" },
      ci: { commitSha: "abc123" },
    });

    // A read has no launcher. A CI envelope on every request would announce
    // the job to routes with no use for it, and repeat a fact that belongs to
    // exactly one moment — the launch.
    await client.getMe();
    await client.listEvalSuites({ projectId: "p_1" });
    await client.updateEvalSuite({
      projectId: "p_1",
      suiteId: "s_1",
      body: { name: "x" },
    });

    for (let call = 0; call < fetchMock.mock.calls.length; call++) {
      const headers = headersOf(fetchMock, call);
      expect(headers["x-mcpjam-launcher"]).toBeUndefined();
      expect(headers["x-mcpjam-ci"]).toBeUndefined();
    }
  });

  it("sends neither header when the client declared neither", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock).createEvalRun({
      projectId: "p_1",
      body: { suiteId: "s_1" },
    });

    const headers = headersOf(fetchMock);
    expect(headers["x-mcpjam-launcher"]).toBeUndefined();
    expect(headers["x-mcpjam-ci"]).toBeUndefined();
    // And the launch is otherwise identical — the label is additive.
    expect(headers.authorization).toBe("Bearer sk_test");
  });

  it("omits an envelope that has nothing in it, rather than sending {}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      launcher: { kind: "cli" },
      // What `detectCiMetadata()` would produce if it looked and found nothing
      // usable. `{}` on the wire reads back as "we recorded CI metadata".
      ci: { commitSha: undefined, branch: "" },
    }).createEvalRun({ projectId: "p_1", body: { suiteId: "s_1" } });

    const headers = headersOf(fetchMock);
    expect(headers["x-mcpjam-launcher"]).toBeDefined();
    expect(headers["x-mcpjam-ci"]).toBeUndefined();
  });

  it("drops undefined fields instead of serializing them as null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      launcher: {
        kind: "mcp",
        client: "claude-code/1.2.3",
        version: undefined,
      },
    }).createEvalRun({ projectId: "p_1", body: { suiteId: "s_1" } });

    // A header full of nulls would claim the process looked for a version and
    // found none, when it never looked.
    expect(headersOf(fetchMock)["x-mcpjam-launcher"]).toBe(
      '{"kind":"mcp","client":"claude-code/1.2.3"}'
    );
  });
});

/**
 * The file-sync marker travels the same road as the launcher, for the same
 * reason: a `PlatformOperation` input becomes an MCP tool input verbatim, so
 * `declaredSuiteId` on one is a field a model could set to claim it is the
 * owning file. The CLIENT knows whether this process is a file sync; a tool
 * caller does not.
 */
describe("withFileSync", () => {
  const bodyOf = (fetchMock: FetchMock, call = 0): Record<string, unknown> =>
    JSON.parse(fetchMock.mock.calls[call][1].body as string);

  it("marks the environment attach as the owning file's write", async () => {
    // `--compose --save-targets` appends cells the file's own run just minted,
    // and `suite.environments` is CI-locked — so without the marker this 409s
    // on the suite the same command just made file-owned.
    const fetchMock = vi.fn().mockResolvedValue(ok({ attached: true }));
    await makeClient(fetchMock)
      .withFileSync("s_checkout")
      .attachEvalSuiteEnvironment({
        projectId: "proj_1",
        suiteId: "suite_1",
        environmentId: "env_1",
      });
    expect(bodyOf(fetchMock)).toEqual({
      environmentId: "env_1",
      declaredSuiteId: "s_checkout",
    });
  });

  it("sends nothing extra when the process is not a file sync", async () => {
    // The ordinary case, and the one that must stay clean: an agent or an app
    // attaching an environment has no file to speak for.
    const fetchMock = vi.fn().mockResolvedValue(ok({ attached: true }));
    await makeClient(fetchMock).attachEvalSuiteEnvironment({
      projectId: "proj_1",
      suiteId: "suite_1",
      environmentId: "env_1",
    });
    expect(bodyOf(fetchMock)).toEqual({ environmentId: "env_1" });
  });

  it("returns a COPY, leaving the original client unmarked", async () => {
    // One client serves a whole command. Mutating it would leave every later
    // call — including ones about other suites — claiming to be this file.
    const fetchMock = vi.fn().mockResolvedValue(ok({ attached: true }));
    const client = makeClient(fetchMock);
    const synced = client.withFileSync("s_checkout");
    expect(synced).not.toBe(client);

    await client.attachEvalSuiteEnvironment({
      projectId: "proj_1",
      suiteId: "suite_1",
      environmentId: "env_1",
    });
    expect(bodyOf(fetchMock)).toEqual({ environmentId: "env_1" });
  });

  it("keeps the launcher and CI declarations across the copy", async () => {
    // The copy is the client the LAUNCH runs on, so losing these would trade
    // one bug for another: the run would attach fine and badge as `API`.
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await makeClient(fetchMock, {
      launcher: { kind: "cli", client: "mcpjam-cli" },
      ci: { provider: "github_actions", commitSha: "abc123" },
    })
      .withFileSync("s_checkout")
      .createEvalRun({ projectId: "proj_1", body: { suiteId: "suite_1" } });
    const headers = headersOf(fetchMock);
    expect(JSON.parse(headers["x-mcpjam-launcher"]).kind).toBe("cli");
    expect(JSON.parse(headers["x-mcpjam-ci"]).commitSha).toBe("abc123");
  });
});
