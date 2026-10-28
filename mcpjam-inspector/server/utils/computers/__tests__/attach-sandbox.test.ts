import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Sandbox, SandboxNotFoundError } from "e2b";
import {
  attachRunningSandbox,
  runningSandboxConnection,
} from "../attach-sandbox.js";

const control = vi.hoisted(() => ({ status: vi.fn(), prepare: vi.fn() }));
vi.mock("../control-plane-client.js", () => ({
  getSandboxEgressStatus: control.status,
  prepareSandboxConnection: control.prepare,
}));
const data = {
  sandboxID: "box-1",
  domain: "e2b.test",
  envdVersion: "0.2.0",
  envdAccessToken: "connection-token",
  state: "running",
  lifecycle: { autoResume: false },
  network: {
    transform: { headers: { authorization: "never-copy-network-secret" } },
  },
};
const opts = { apiKey: "test-vendor-key", apiUrl: "" };
const requests: Array<{ method: string | undefined }> = [];
let responseBody: unknown = data;
let responseStatus = 200;
const server = http.createServer((request, response) => {
  requests.push({ method: request.method });
  response.writeHead(responseStatus, { "content-type": "application/json" });
  response.end(JSON.stringify(responseBody));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  opts.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  requests.length = 0;
  responseBody = data;
  responseStatus = 200;
  control.status
    .mockReset()
    .mockResolvedValue({ ok: true, value: { ok: true } });
  control.prepare
    .mockReset()
    .mockResolvedValue({ ok: true, value: { ok: true } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("controlled sandbox attachment", () => {
  it("renews through the backend and uses only GET at the vendor", async () => {
    const directConnect = vi.spyOn(Sandbox, "connect");
    const box = await attachRunningSandbox("box-1", opts);
    expect(box.sandboxId).toBe("box-1");
    expect(control.prepare).toHaveBeenCalledOnce();
    expect(control.status).toHaveBeenCalledTimes(2);
    expect(directConnect).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
  });
  it("copies only connection fields, not the secret-bearing network response", async () => {
    const connection = await runningSandboxConnection("box-1", opts);
    expect(connection).toEqual({
      ...opts,
      sandboxId: "box-1",
      sandboxDomain: "e2b.test",
      envdVersion: "0.2.0",
      envdAccessToken: "connection-token",
    });
    expect(JSON.stringify(connection)).not.toContain(
      "never-copy-network-secret",
    );
    expect(connection.signal).toBeUndefined();
  });
  it("refuses a quarantine before calling prepare or the vendor", async () => {
    control.status.mockResolvedValue({
      ok: true,
      value: { ok: false, reason: "unavailable" },
    });
    await expect(attachRunningSandbox("box-1", opts)).rejects.toMatchObject({
      code: "sandbox_policy_unavailable",
    });
    expect(control.prepare).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
  it("refuses if quarantine starts during connection discovery", async () => {
    control.status
      .mockResolvedValueOnce({ ok: true, value: { ok: true } })
      .mockResolvedValueOnce({
        ok: true,
        value: { ok: false, reason: "unavailable" },
      });
    await expect(attachRunningSandbox("box-1", opts)).rejects.toMatchObject({
      code: "sandbox_policy_unavailable",
    });
  });
  it("fails closed if the policy service cannot be reached", async () => {
    control.status.mockResolvedValue({
      ok: false,
      status: 503,
      error: "unavailable",
    });
    await expect(attachRunningSandbox("box-1", opts)).rejects.toThrow(
      "Could not check",
    );
    expect(requests).toHaveLength(0);
  });
  it("does not fall back to direct connect when preparation fails", async () => {
    control.prepare.mockResolvedValue({
      ok: false,
      status: 503,
      error: "unavailable",
    });
    await expect(attachRunningSandbox("box-1", opts)).rejects.toThrow(
      "Could not prepare",
    );
    expect(requests).toHaveLength(0);
  });
  it("waits for a current policy write before preparing", async () => {
    control.status.mockResolvedValueOnce({
      ok: true,
      value: { ok: false, reason: "egress_busy", deadline: Date.now() + 2000 },
    });
    await attachRunningSandbox("box-1", opts);
    expect(control.status).toHaveBeenCalledTimes(3);
  });
  it("stops at the policy write deadline", async () => {
    control.status.mockResolvedValue({
      ok: true,
      value: { ok: false, reason: "egress_busy", deadline: Date.now() - 1 },
    });
    await expect(attachRunningSandbox("box-1", opts)).rejects.toThrow(
      "still being updated",
    );
    expect(control.prepare).not.toHaveBeenCalled();
  });
  it("honors an already-aborted caller without any network request", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      attachRunningSandbox("box-1", { ...opts, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    expect(requests).toHaveLength(0);
    expect(control.prepare).not.toHaveBeenCalled();
  });
  it.each([
    { ...data, state: "paused" },
    { ...data, lifecycle: { autoResume: true } },
    { ...data, envdAccessToken: undefined },
    { ...data, sandboxID: "other-box" },
  ])("refuses unsafe or mismatched provider state", async (response) => {
    responseBody = response;
    await expect(attachRunningSandbox("box-1", opts)).rejects.toThrow();
  });
  it("preserves the typed missing-sandbox error", async () => {
    responseStatus = 404;
    responseBody = {};
    await expect(attachRunningSandbox("box-1", opts)).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
  });
});

it("preserves missing-sandbox classification from backend preparation", async () => {
  control.prepare.mockResolvedValue({
    ok: false,
    status: 404,
    code: "sandbox_not_found",
    error: "unavailable",
  });
  await expect(attachRunningSandbox("box-1", opts)).rejects.toBeInstanceOf(
    SandboxNotFoundError,
  );
  expect(requests).toHaveLength(0);
});
