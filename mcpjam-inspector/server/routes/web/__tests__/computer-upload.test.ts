import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  createComputerUploadHandler,
  type UploadSandbox,
} from "../computer-upload";
import { resetComputerTerminalJwksCacheForTests } from "../../../utils/computers/terminal-token.js";

// Route-level tests for POST /api/web/computers/upload. The control plane
// (`/computers/sandbox-info`) is a fetch stub; the E2B sandbox is an injected
// fake that records makeDir/write calls. Terminal tokens are RS256, verified
// against a stubbed JWKS at `/computers/terminal-jwks`.

const ISSUER = "https://api.mcpjam.com/computer-terminal";
const CONVEX_URL = "https://convex.example";
const KID = "computer-terminal-1";

let signingKey: CryptoKey;
let jwksDoc: unknown;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  signingKey = kp.privateKey as CryptoKey;
  const jwk = await exportJWK(kp.publicKey);
  jwksDoc = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
});

async function signToken(
  claims: Record<string, unknown> = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const {
    iss = ISSUER,
    iat = now,
    exp = now + 60,
    ...rest
  } = {
    purpose: "computer-terminal",
    sub: "users_123",
    computerId: "computers_456",
    projectId: "projects_789",
    ...claims,
  } as Record<string, unknown> & { iss?: string; iat?: number; exp?: number };
  return new SignJWT(rest)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(iss)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(signingKey);
}

function fakeSandbox() {
  const writes: { path: string; bytes: number }[] = [];
  let madeDir = 0;
  const sandbox: UploadSandbox = {
    files: {
      makeDir: async () => {
        madeDir += 1;
        return true;
      },
      write: async (path, data) => {
        writes.push({ path, bytes: data.byteLength });
      },
    },
  };
  return {
    sandbox,
    writes,
    get madeDirCount() {
      return madeDir;
    },
  };
}

function installSandboxInfoStub(
  override?: (path: string) => { status: number; json: unknown } | undefined
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      const custom = override?.(path);
      if (custom) {
        return new Response(JSON.stringify(custom.json), {
          status: custom.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/computers/sandbox-info") {
        return new Response(
          JSON.stringify({
            computerId: "computers_456",
            providerComputerId: "sbx_42",
            provider: "e2b",
            status: "ready",
            projectId: "projects_789",
            ownerUserId: "users_123",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (path === "/computers/terminal-jwks") {
        return new Response(JSON.stringify(jwksDoc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/computers/reserve-upload-bytes") {
        return new Response(
          JSON.stringify({ ok: true, total: 100, cap: 500 * 1024 * 1024 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected path ${path}`);
    })
  );
}

function stubConfiguredEnv() {
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-svc-token");
  vi.stubEnv("E2B_API_KEY", "e2b_test");
  vi.stubEnv(
    "COMPUTERS_TERMINAL_TOKEN_SECRET",
    "test-terminal-secret-0123456789"
  );
}

function createApp(connectSandbox: (id: string) => Promise<UploadSandbox>) {
  const app = new Hono();
  app.post(
    "/api/web/computers/upload",
    createComputerUploadHandler({ connectSandbox })
  );
  return app;
}

async function uploadRequest(
  app: Hono,
  token: string | null,
  files: File[],
  dir?: string
): Promise<Response> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const params = new URLSearchParams();
  if (dir) params.set("dir", dir);
  const qs = params.toString();
  return await app.request(`/api/web/computers/upload${qs ? `?${qs}` : ""}`, {
    method: "POST",
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  installSandboxInfoStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetComputerTerminalJwksCacheForTests();
});

describe("POST /api/web/computers/upload", () => {
  it("503s when the data plane is unconfigured", async () => {
    // No env stubbed → isComputersDataPlaneConfigured() is false.
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1, 2, 3])], "a.txt"),
    ]);
    expect(res.status).toBe(503);
    expect(fake.writes).toHaveLength(0);
  });

  it("401s on an invalid token", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, "not.a.token", [
      new File([new Uint8Array([1])], "a.txt"),
    ]);
    expect(res.status).toBe(401);
    expect(fake.writes).toHaveLength(0);
  });

  it("401s when no credentials are provided at all", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, null, [
      new File([new Uint8Array([1])], "a.txt"),
    ]);
    expect(res.status).toBe(401);
    expect(fake.writes).toHaveLength(0);
  });

  it("401s on a ?token= query string alone (no header fallback)", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const form = new FormData();
    form.append("files", new File([new Uint8Array([1, 2])], "a.txt"));
    const res = await app.request(
      `/api/web/computers/upload?token=${encodeURIComponent(
        await signToken()
      )}`,
      { method: "POST", body: form }
    );
    expect(res.status).toBe(401);
    expect(fake.writes).toHaveLength(0);
  });

  it("400s when no files are attached", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), []);
    expect(res.status).toBe(400);
  });

  it("413s when too many files are attached", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const files = Array.from(
      { length: 21 },
      (_, i) => new File([new Uint8Array([i])], `f${i}.txt`)
    );
    const res = await uploadRequest(app, await signToken(), files);
    expect(res.status).toBe(413);
    expect(fake.writes).toHaveLength(0);
  });

  it("413s when a file exceeds the per-file size cap", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.bin");
    const res = await uploadRequest(app, await signToken(), [big]);
    expect(res.status).toBe(413);
    expect(fake.writes).toHaveLength(0);
  });

  it("sanitizes a path-traversal filename to a basename under the upload root", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1, 2])], "../../etc/passwd"),
    ]);
    expect(res.status).toBe(200);
    expect(fake.writes).toHaveLength(1);
    const writtenPath = fake.writes[0].path;
    expect(writtenPath.startsWith("/home/user/uploads/")).toBe(true);
    expect(writtenPath).not.toContain("..");
    // basename preserved (after the random prefix), no directory components.
    expect(writtenPath).toMatch(/\/home\/user\/uploads\/[0-9a-f]{8}-passwd$/);
  });

  it("writes each file and returns absolute paths on the happy path", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1, 2, 3])], "one.png"),
      new File([new Uint8Array([4, 5])], "two.txt"),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      files: { name: string; path: string; bytes: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.files).toHaveLength(2);
    expect(fake.madeDirCount).toBe(1);
    expect(fake.writes).toHaveLength(2);
    expect(body.files[0].bytes).toBe(3);
    expect(body.files[1].bytes).toBe(2);
    for (const f of body.files) {
      expect(f.path.startsWith("/home/user/uploads/")).toBe(true);
    }
  });

  it("writes into a valid requested dir under the box home (harness workdir)", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(
      app,
      await signToken(),
      [new File([new Uint8Array([1])], "shot.png")],
      "/home/user/claude-code-XyZ"
    );
    expect(res.status).toBe(200);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].path).toMatch(
      /^\/home\/user\/claude-code-XyZ\/[0-9a-f]{8}-shot\.png$/
    );
  });

  it("falls back to the upload bucket for a dir outside the box home", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(
      app,
      await signToken(),
      [new File([new Uint8Array([1])], "x.txt")],
      "/etc"
    );
    expect(res.status).toBe(200);
    expect(fake.writes[0].path.startsWith("/home/user/uploads/")).toBe(true);
  });

  it("falls back to the upload bucket for a traversal dir", async () => {
    stubConfiguredEnv();
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(
      app,
      await signToken(),
      [new File([new Uint8Array([1])], "x.txt")],
      "/home/user/../../etc"
    );
    expect(res.status).toBe(200);
    expect(fake.writes[0].path.startsWith("/home/user/uploads/")).toBe(true);
  });

  it("503s when the sandbox is asleep (connect throws)", async () => {
    stubConfiguredEnv();
    const app = createApp(async () => {
      throw new Error("sandbox not found");
    });
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1])], "a.txt"),
    ]);
    expect(res.status).toBe(503);
  });

  it("401s when the sandbox-info row's owner doesn't match the token's claims", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub((path) =>
      path === "/computers/sandbox-info"
        ? {
            status: 200,
            json: {
              computerId: "computers_456",
              providerComputerId: "sbx_42",
              provider: "e2b",
              status: "ready",
              projectId: "projects_789",
              ownerUserId: "users_other",
            },
          }
        : undefined
    );
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1])], "a.txt"),
    ]);
    expect(res.status).toBe(401);
    expect(fake.writes).toHaveLength(0);
  });

  it("401s when the sandbox-info row's project doesn't match the token's claims", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub((path) =>
      path === "/computers/sandbox-info"
        ? {
            status: 200,
            json: {
              computerId: "computers_456",
              providerComputerId: "sbx_42",
              provider: "e2b",
              status: "ready",
              projectId: "projects_other",
              ownerUserId: "users_123",
            },
          }
        : undefined
    );
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1])], "a.txt"),
    ]);
    expect(res.status).toBe(401);
    expect(fake.writes).toHaveLength(0);
  });

  it("413s and writes nothing when the upload exceeds the cumulative quota", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub((path) =>
      path === "/computers/reserve-upload-bytes"
        ? {
            status: 413,
            json: {
              error: "Upload would exceed this computer's storage quota.",
              total: 500 * 1024 * 1024,
              cap: 500 * 1024 * 1024,
            },
          }
        : undefined
    );
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1, 2, 3])], "a.txt"),
    ]);
    expect(res.status).toBe(413);
    expect(fake.writes).toHaveLength(0);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/quota/i);
  });

  it("fails OPEN (still writes) when the quota reserve route is unavailable (404)", async () => {
    // An older backend without the reserve route returns 404. The quota is a
    // hygiene control, not the trust boundary, so the upload proceeds.
    stubConfiguredEnv();
    installSandboxInfoStub((path) =>
      path === "/computers/reserve-upload-bytes"
        ? { status: 404, json: { error: "Computer not found" } }
        : undefined
    );
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1, 2, 3])], "a.txt"),
    ]);
    expect(res.status).toBe(200);
    expect(fake.writes).toHaveLength(1);
  });

  it("503s when the computer is still provisioning (no providerComputerId)", async () => {
    stubConfiguredEnv();
    installSandboxInfoStub((path) =>
      path === "/computers/sandbox-info"
        ? {
            status: 200,
            json: {
              computerId: "computers_456",
              providerComputerId: null,
              provider: "e2b",
              status: "provisioning",
              projectId: "projects_789",
              ownerUserId: "users_123",
            },
          }
        : undefined
    );
    const fake = fakeSandbox();
    const app = createApp(async () => fake.sandbox);
    const res = await uploadRequest(app, await signToken(), [
      new File([new Uint8Array([1])], "a.txt"),
    ]);
    expect(res.status).toBe(503);
    expect(fake.writes).toHaveLength(0);
  });
});
