import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebTestApp,
  expectJson,
  getJson,
  postJson,
} from "./helpers/test-app.js";

const { executeOAuthProxyMock, fetchOAuthMetadataMock } = vi.hoisted(() => ({
  executeOAuthProxyMock: vi.fn(),
  fetchOAuthMetadataMock: vi.fn(),
}));

vi.mock("../../../utils/oauth-proxy.js", () => ({
  executeOAuthProxy: executeOAuthProxyMock,
  fetchOAuthMetadata: fetchOAuthMetadataMock,
  OAuthProxyError: class OAuthProxyError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { OAuthProxyError } from "../../../utils/oauth-proxy.js";

interface OAuthErrorResponse {
  code: string;
  message: string;
  error: string;
}

describe("web routes — oauth no-auth required", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
  });

  it("POST /proxy succeeds without bearer token", async () => {
    executeOAuthProxyMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { ok: true },
    });

    const response = await postJson(app, "/api/web/oauth/proxy", {
      url: "https://example.com/token",
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual({ status: 200, statusText: "OK", headers: {}, body: { ok: true } });
  });

  it("GET /metadata succeeds without bearer token", async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      metadata: { issuer: "https://example.com" },
    });

    const response = await getJson(
      app,
      "/api/web/oauth/metadata?url=https://example.com/.well-known/oauth",
    );
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual({ issuer: "https://example.com" });
  });
});

describe("web routes — oauth error contract", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    executeOAuthProxyMock.mockReset();
    fetchOAuthMetadataMock.mockReset();
  });

  it("returns compatibility payload for OAuthProxyError on /proxy", async () => {
    executeOAuthProxyMock.mockRejectedValueOnce(
      new OAuthProxyError(400, "Invalid URL format"),
    );

    const response = await postJson(
      app,
      "/api/web/oauth/proxy",
      { url: "bad-url" },
      token,
    );
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(400);
    expect(data).toEqual({
      code: "VALIDATION_ERROR",
      message: "Invalid URL format",
      error: "Invalid URL format",
    });
  });

  it("returns compatibility payload for missing metadata url", async () => {
    const response = await getJson(app, "/api/web/oauth/metadata", token);
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(400);
    expect(data).toEqual({
      code: "VALIDATION_ERROR",
      message: "Missing url parameter",
      error: "Missing url parameter",
    });
  });

  it("returns compatibility payload for metadata upstream status errors", async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      status: 502,
      statusText: "Bad Gateway",
    });

    const response = await getJson(
      app,
      "/api/web/oauth/metadata?url=https://oauth.example/.well-known/oauth",
      token,
    );
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(502);
    expect(data).toEqual({
      code: "SERVER_UNREACHABLE",
      message: "Failed to fetch OAuth metadata: 502 Bad Gateway",
      error: "Failed to fetch OAuth metadata: 502 Bad Gateway",
    });
  });

  it("returns compatibility payload for generic runtime errors", async () => {
    executeOAuthProxyMock.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED"),
    );

    const response = await postJson(
      app,
      "/api/web/oauth/proxy",
      { url: "https://oauth.example/token", method: "POST", body: {} },
      token,
    );
    const { status, data } = await expectJson<OAuthErrorResponse>(response);

    expect(status).toBe(502);
    expect(data).toEqual({
      code: "SERVER_UNREACHABLE",
      message: "connect ECONNREFUSED",
      error: "connect ECONNREFUSED",
    });
  });
});
