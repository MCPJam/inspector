/**
 * A ChatGPT plugin submission's subject and its runs: the PATCH route sets
 * the stored plugin and the attempt under the revision guard, and a run
 * grades the stored plugin version the caller names, never one read off the
 * submission.
 *
 * Convex is mocked at `convex/browser` as in `directory-submissions.test.ts`;
 * these prove the gateway's checks and the args it forwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { CHATGPT_PLUGIN_FLOW, CLAUDE_CONNECTOR_FLOW } from "@mcpjam/sdk";

const {
  validateGuestTokenMock,
  convexQueryMock,
  convexMutationMock,
  authorizeServerMock,
  executeHostedReadinessRunMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executeHostedReadinessRunMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: convexMutationMock,
    };
  }),
}));
vi.mock("../../../services/readiness/worker.js", () => ({
  executeHostedReadinessRun: executeHostedReadinessRunMock,
}));
vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../../web/auth.js");
  return { ...actual, authorizeServer: authorizeServerMock };
});

import v1Routes from "../index.js";
import { toReadinessRunDto } from "../../shared/readiness-runs.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SERVER = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const PLUGIN = "plgxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const PLUGIN_VERSION = "pvxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BASE = `/api/v1/projects/${PROJECT}/directory-submissions`;

const PLUGIN_ROW = {
  id: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  directory: "openai",
  flowId: CHATGPT_PLUGIN_FLOW.id,
  flowVersion: CHATGPT_PLUGIN_FLOW.version,
  answers: [],
  revision: 3,
  createdBy: "user_1",
  pluginId: PLUGIN,
  pluginVersionId: PLUGIN_VERSION,
  attempt: 1,
  createdAt: 5,
  updatedAt: 10,
};

const CONNECTOR_ROW = {
  ...PLUGIN_ROW,
  directory: "claude",
  flowId: CLAUDE_CONNECTOR_FLOW.id,
  flowVersion: CLAUDE_CONNECTOR_FLOW.version,
  pluginId: undefined,
  pluginVersionId: undefined,
};

let row: Record<string, unknown>;
let requestRun: (args: Record<string, unknown>) => unknown;

function nameOf(ref: unknown): string {
  return typeof ref === "string" ? ref : getFunctionName(ref as never);
}

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function mutationArgs(name: string): Record<string, unknown> {
  const call = convexMutationMock.mock.calls.find(
    ([ref]) => nameOf(ref) === name,
  );
  expect(call, `${name} was not called`).toBeDefined();
  return call![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.example.com");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  row = PLUGIN_ROW;
  requestRun = () => ({ runId: RUN, jobId: "job_1", reused: false });
  convexQueryMock.mockImplementation(async (ref) => {
    if (nameOf(ref) === "directorySubmissions:getDirectorySubmission")
      return row;
    throw new Error(`unexpected query ${nameOf(ref)}`);
  });
  convexMutationMock.mockImplementation(async (ref, args) => {
    const name = nameOf(ref);
    if (name === "directorySubmissions:updateDirectorySubmission") {
      return { ...row, revision: 4 };
    }
    if (name === "claudeReadinessRuns:requestReadinessRun")
      return requestRun(args);
    throw new Error(`unexpected mutation ${name}`);
  });
  authorizeServerMock.mockResolvedValue({
    authorized: true,
    serverConfig: { transportType: "http", url: "https://mcp.example.com/mcp" },
  });
  executeHostedReadinessRunMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a ChatGPT plugin submission's plugin and attempt", () => {
  it("reads back with the submission", async () => {
    const res = await request("GET", `${BASE}/${SUBMISSION}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pluginId: PLUGIN,
      pluginVersionId: PLUGIN_VERSION,
      attempt: 1,
    });
  });

  it("forwards a plugin version and an attempt under the revision guard", async () => {
    const res = await request("PATCH", `${BASE}/${SUBMISSION}`, {
      expectedRevision: 3,
      plugin: { pluginVersionId: PLUGIN_VERSION },
      attempt: 2,
    });
    expect(res.status).toBe(200);
    expect(
      mutationArgs("directorySubmissions:updateDirectorySubmission"),
    ).toEqual({
      submissionId: SUBMISSION,
      expectedRevision: 3,
      plugin: { pluginVersionId: PLUGIN_VERSION },
      attempt: 2,
      setVia: "api",
    });
  });

  it("clears both with null", async () => {
    await request("PATCH", `${BASE}/${SUBMISSION}`, {
      expectedRevision: 3,
      plugin: null,
      attempt: null,
    });
    expect(
      mutationArgs("directorySubmissions:updateDirectorySubmission"),
    ).toMatchObject({
      plugin: null,
      attempt: null,
    });
  });

  it.each([
    [
      "a malformed plugin version id",
      { plugin: { pluginVersionId: "nope" } },
      404,
    ],
    [
      "a key the plugin does not take",
      { plugin: { pluginId: PLUGIN, name: "x" } },
      400,
    ],
    ["an attempt below one", { attempt: 0 }, 400],
  ])("refuses %s before Convex sees it", async (_label, change, status) => {
    const res = await request("PATCH", `${BASE}/${SUBMISSION}`, {
      expectedRevision: 3,
      ...change,
    });
    expect(res.status).toBe(status);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });
});

describe("a ChatGPT plugin submission's run", () => {
  it("grades the named version as a package beside the saved server", async () => {
    const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
      pluginVersionId: PLUGIN_VERSION,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      readinessKind: "openai",
    });
    expect(
      mutationArgs("claudeReadinessRuns:requestReadinessRun"),
    ).toMatchObject({
      readinessKind: "openai",
      submissionMode: "mcp-uploaded-skills",
      submissionId: SUBMISSION,
      pluginVersionId: PLUGIN_VERSION,
      serverUrl: "https://mcp.example.com/mcp",
    });
    expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
      publisher: "openai",
      submissionMode: "mcp-uploaded-skills",
      submissionId: SUBMISSION,
      target: "https://mcp.example.com/mcp",
    });
  });

  it("refuses a run that names no version, never reading the submission's", async () => {
    const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(
      /^pluginVersionId: .*Send the version to grade\.$/,
    );
    expect(convexMutationMock).not.toHaveBeenCalled();
    expect(authorizeServerMock).not.toHaveBeenCalled();
  });

  it("answers a malformed version id as not found", async () => {
    const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
      pluginVersionId: "not-an-id",
    });
    expect(res.status).toBe(404);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("passes the backend's refusal of a version on, in its words", async () => {
    requestRun = () => {
      throw new ConvexError({
        code: "plugin_version_not_ready",
        message:
          "This plugin version is still importing or failed to import. Pick a ready version of the plugin.",
      });
    };
    const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
      pluginVersionId: PLUGIN_VERSION,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "still importing",
    );
    expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
  });

  it("refuses a plugin version on a connector submission", async () => {
    row = CONNECTOR_ROW;
    const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
      pluginVersionId: PLUGIN_VERSION,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(
      /Only a ChatGPT plugin submission grades a plugin version/,
    );
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("is read back with the version it graded, and null without one", () => {
    const run = { id: RUN, status: "completed", createdAt: 1, updatedAt: 2 };
    const options = { projectId: PROJECT };
    expect(
      toReadinessRunDto({ ...run, pluginVersionId: PLUGIN_VERSION }, options),
    ).toMatchObject({ pluginVersionId: PLUGIN_VERSION });
    expect(toReadinessRunDto(run, options).pluginVersionId).toBeNull();
  });
});
