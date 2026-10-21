import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveLocalOAuthHeaders,
  stageLocalOAuthHeaders,
  recoverLocalOAuthHeaders,
} from "../local-oauth-recovery";
import {
  fetchServerSecrets,
  fetchOAuthRecoveryHeaders,
  stageOAuthRecoveryHeaders,
} from "@/lib/apis/server-secrets-api";
vi.mock("@/lib/apis/server-secrets-api", () => ({
  fetchServerSecrets: vi.fn(),
  fetchOAuthRecoveryHeaders: vi.fn(),
  stageOAuthRecoveryHeaders: vi.fn(),
}));

describe("local OAuth header recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });
  it("stages the exact merged headers with a server-valid handle", async () => {
    await stageLocalOAuthHeaders("bound", "https://example.com/mcp", {
      "X-Project": "default",
      "X-Server": "selected",
      Authorization: "Bearer transport",
    });
    const handle = sessionStorage.getItem("mcp-oauth-recovery-handle-bound");
    expect(handle).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(stageOAuthRecoveryHeaders).toHaveBeenCalledWith({
      serverName: "bound",
      serverUrl: "https://example.com/mcp",
      recoveryHandle: handle,
      headers: { "X-Project": "default", "X-Server": "selected" },
    });
    vi.mocked(fetchOAuthRecoveryHeaders).mockResolvedValueOnce({
      "X-Project": "default",
      "X-Server": "selected",
    });
    expect(
      await recoverLocalOAuthHeaders("bound", "https://example.com/mcp", {
        hasCustomHeaders: true,
      }),
    ).toEqual({ "X-Project": "default", "X-Server": "selected" });
    expect(
      sessionStorage.getItem("mcp-oauth-recovery-handle-bound"),
    ).toBeNull();
    expect(localStorage.length).toBe(0);
  });
  it("does not stage an Authorization-only flow and clears an old handle", async () => {
    sessionStorage.setItem("mcp-oauth-recovery-handle-bound", "old");
    await stageLocalOAuthHeaders("bound", "https://example.com/mcp", {
      authorization: "transport",
    });
    expect(stageOAuthRecoveryHeaders).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem("mcp-oauth-recovery-handle-bound"),
    ).toBeNull();
    expect(
      await recoverLocalOAuthHeaders("bound", "https://example.com/mcp", {
        hasCustomHeaders: false,
      }),
    ).toBeUndefined();
  });
  it("asks for a new flow when a handle is missing instead of revealing stored secrets", async () => {
    await expect(
      recoverLocalOAuthHeaders("bound", "https://example.com/mcp", {
        hasCustomHeaders: true,
      }),
    ).rejects.toThrow(/retry authorization/);
    expect(fetchOAuthRecoveryHeaders).not.toHaveBeenCalled();
  });
  it("retains the handle if recovery fails", async () => {
    sessionStorage.setItem("mcp-oauth-recovery-handle-bound", "pending");
    vi.mocked(fetchOAuthRecoveryHeaders).mockRejectedValueOnce(
      new Error("offline"),
    );
    await expect(
      recoverLocalOAuthHeaders("bound", "https://example.com/mcp", {
        hasCustomHeaders: true,
      }),
    ).rejects.toThrow("offline");
    expect(sessionStorage.getItem("mcp-oauth-recovery-handle-bound")).toBe(
      "pending",
    );
  });
  it("recovers saved headers through edit permissions before discovery and merges project defaults", async () => {
    vi.mocked(fetchServerSecrets).mockResolvedValueOnce({
      env: null,
      headers: { "X-Server": "saved", Authorization: "Bearer transport" },
    });
    expect(
      await resolveLocalOAuthHeaders(
        { "X-Project": "default" },
        { projectId: "project", serverId: "server" },
        true,
      ),
    ).toEqual({ "X-Project": "default", "X-Server": "saved" });
    expect(fetchServerSecrets).toHaveBeenCalledWith({
      projectId: "project",
      serverId: "server",
    });
  });
  it("honors edit-permission failures instead of falling back to runtime reveal", async () => {
    vi.mocked(fetchServerSecrets).mockRejectedValueOnce(
      new Error("Edit access required"),
    );
    await expect(
      resolveLocalOAuthHeaders(
        {},
        { projectId: "project", serverId: "server" },
        true,
      ),
    ).rejects.toThrow("Edit access required");
    expect(fetchOAuthRecoveryHeaders).not.toHaveBeenCalled();
  });
});
