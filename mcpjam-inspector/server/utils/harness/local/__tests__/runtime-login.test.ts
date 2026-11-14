/**
 * The login a local turn asks for when its CLI reaches its own vendor
 * (Cursor): signed by this machine's instance key, the access token alone
 * kept, and the backend's refusal passed on as it wrote it.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLocalInstanceKey,
  resetInstanceKeyCacheForTests,
} from "../instance-key.js";
import {
  clearRuntimeLogin,
  installRuntimeLogin,
  RUNTIME_LOGIN_CLEAR_PATH,
  RUNTIME_LOGIN_INSTALL_PATH,
} from "../runtime-login.js";

const SCOPE = {
  harnessId: "cursor",
  projectId: "proj_1",
  modelId: "cursor/auto",
  machineId: "mach_abcdef0123456789",
  keyId: "hik_1",
};
const EXPIRES_AT = Date.now() + 3_600_000;

let home: string;
let realHome: string | undefined;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-runtime-login-")));
  realHome = process.env.HOME;
  process.env.HOME = home;
  resetInstanceKeyCacheForTests();
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetInstanceKeyCacheForTests();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

/** Whether a proof header verifies against this machine's public key. */
async function signedByThisMachine(
  header: string,
  path: string,
  installId: string,
) {
  const [timestamp, nonce, signature] = header.split(".");
  const { publicKey } = await loadLocalInstanceKey();
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKey, "base64url"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  // The jti written out, as the backend's route checks it.
  const signingString = [
    "mcpjam-pop-v1",
    "POST",
    path,
    timestamp,
    nonce,
    `local-runtime-login:${installId}`,
  ].join("\n");
  return crypto.subtle.verify(
    "Ed25519",
    key,
    Buffer.from(signature ?? "", "base64url"),
    new TextEncoder().encode(signingString),
  );
}

function answer(respond: (body: Record<string, unknown>) => Response) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
    respond(JSON.parse(String(init.body)) as Record<string, unknown>),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("installRuntimeLogin", () => {
  it("asks the backend with a request this machine signed, and keeps the access token alone", async () => {
    const fetchMock = answer((body) =>
      Response.json({
        ok: true,
        installId: body.installId,
        accessToken: "cursor-access",
        expiresAt: EXPIRES_AT,
      }),
    );
    const result = await installRuntimeLogin({
      ...SCOPE,
      bearer: "member-bearer",
    });
    expect(result).toEqual({
      ok: true,
      installId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      login: { accessToken: "cursor-access", expiresAt: EXPIRES_AT },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://backend.test${RUNTIME_LOGIN_INSTALL_PATH}`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer member-bearer");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      ...SCOPE,
      installId: result.ok ? result.installId : "",
    });
    await expect(
      signedByThisMachine(
        headers["x-mcpjam-pop"]!,
        RUNTIME_LOGIN_INSTALL_PATH,
        String(body.installId),
      ),
    ).resolves.toBe(true);
    // Bound to this install: the same proof is worthless for another one.
    await expect(
      signedByThisMachine(
        headers["x-mcpjam-pop"]!,
        RUNTIME_LOGIN_INSTALL_PATH,
        "another-install",
      ),
    ).resolves.toBe(false);
  });

  it("refuses an answer for another install", async () => {
    answer(() =>
      Response.json({
        ok: true,
        installId: "someone-else",
        accessToken: "x",
        expiresAt: EXPIRES_AT,
      }),
    );
    const result = await installRuntimeLogin({
      ...SCOPE,
      bearer: "member-bearer",
    });
    expect(result.ok).toBe(false);
  });

  it("passes on the backend's refusal as written", async () => {
    answer(() =>
      Response.json(
        {
          ok: false,
          error:
            "Ask an org admin to add a Cursor key in Organization → AI providers.",
        },
        { status: 403 },
      ),
    );
    await expect(
      installRuntimeLogin({ ...SCOPE, bearer: "member-bearer" }),
    ).resolves.toEqual({
      ok: false,
      message:
        "Ask an org admin to add a Cursor key in Organization → AI providers.",
    });
  });

  it("says when MCPJam cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const result = await installRuntimeLogin({
      ...SCOPE,
      bearer: "member-bearer",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(/could not be reached/);
  });
});

describe("clearRuntimeLogin", () => {
  it("records the removal with a signed request for the same install", async () => {
    const fetchMock = answer(() => Response.json({ ok: true }));
    await clearRuntimeLogin({
      ...SCOPE,
      installId: "0e2c6a7b-3f4d-4a1e-9b8c-1d2e3f4a5b6c",
      bearer: "member-bearer",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://backend.test${RUNTIME_LOGIN_CLEAR_PATH}`);
    const headers = init.headers as Record<string, string>;
    await expect(
      signedByThisMachine(
        headers["x-mcpjam-pop"]!,
        RUNTIME_LOGIN_CLEAR_PATH,
        "0e2c6a7b-3f4d-4a1e-9b8c-1d2e3f4a5b6c",
      ),
    ).resolves.toBe(true);
  });

  it("never throws: the login expires within the hour either way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await expect(
      clearRuntimeLogin({
        ...SCOPE,
        installId: "0e2c6a7b-3f4d-4a1e-9b8c-1d2e3f4a5b6c",
        bearer: "member-bearer",
      }),
    ).resolves.toBeUndefined();
  });
});
