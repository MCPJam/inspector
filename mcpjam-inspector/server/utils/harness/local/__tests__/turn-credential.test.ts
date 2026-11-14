/**
 * A turn on a runtime login (Cursor): no lease and no gateway, the login only
 * in the supervised process's environment, cleared once when the turn ends. The gateway half is
 * `local-turn.test.ts`'s, through the turn it serves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime-login.js", () => ({
  installRuntimeLogin: vi.fn(),
  clearRuntimeLogin: vi.fn(async () => {}),
}));
vi.mock("../../harness-model-broker.js", () => ({
  startLoopbackModelBroker: vi.fn(),
  revokeHarnessModelBroker: vi.fn(),
}));
vi.mock("../model-gateway.js", () => ({ startLocalModelGateway: vi.fn() }));

import {
  revokeHarnessModelBroker,
  startLoopbackModelBroker,
} from "../../harness-model-broker.js";
import { startLocalModelGateway } from "../model-gateway.js";
import { clearRuntimeLogin, installRuntimeLogin } from "../runtime-login.js";
import {
  openTurnCredential,
  type OpenTurnCredentialArgs,
} from "../turn-credential.js";

const EXPIRES_AT = Date.now() + 3_600_000;

const args = (): OpenTurnCredentialArgs => ({
  credential: {
    kind: "runtime-login",
    adapterAuth: { CURSOR_API_KEY: "" },
    childEnv: (login) => ({
      CURSOR_AUTH_TOKEN: login.accessToken,
      AGENT_CLI_CREDENTIAL_STORE: "memory",
    }),
  },
  harnessId: "cursor",
  projectId: "proj_1",
  modelId: "cursor/auto",
  machineId: "mach_abcdef0123456789",
  keyId: "hik_1",
  runId: "run_1",
  bearer: "member-bearer",
  getCleanupAuthorization: async () => "fresh-bearer",
  isSupervisedPid: () => true,
});

beforeEach(() => {
  vi.mocked(installRuntimeLogin).mockReset();
  vi.mocked(clearRuntimeLogin).mockClear();
});

describe("a runtime login", () => {
  it("takes no lease and starts no gateway, and hands the login to the child, not the adapter", async () => {
    vi.mocked(installRuntimeLogin).mockResolvedValue({
      ok: true,
      installId: "install-1",
      login: { accessToken: "cursor-access", expiresAt: EXPIRES_AT },
    });
    const opened = await openTurnCredential(args());
    if (!opened.ok) throw new Error(opened.message);
    const { credential } = opened;
    expect(credential).toMatchObject({
      kind: "runtime-login",
      brokerRunId: null,
      gateway: null,
    });
    await expect(credential.listen()).resolves.toEqual({
      ok: true,
      auth: { CURSOR_API_KEY: "" },
      env: {
        CURSOR_AUTH_TOKEN: "cursor-access",
        AGENT_CLI_CREDENTIAL_STORE: "memory",
      },
      readyMs: 0,
    });
    expect(installRuntimeLogin).toHaveBeenCalledWith({
      harnessId: "cursor",
      projectId: "proj_1",
      modelId: "cursor/auto",
      machineId: "mach_abcdef0123456789",
      keyId: "hik_1",
      bearer: "member-bearer",
    });
    expect(startLoopbackModelBroker).not.toHaveBeenCalled();
    expect(startLocalModelGateway).not.toHaveBeenCalled();
    // A parked CLI keeps its login; there is no lease to swap in.
    expect(() => credential.hold()).not.toThrow();
    expect(() =>
      credential.rebind({ runId: "r", lease: "l", bearer: "b" }),
    ).toThrow(/no lease/);
  });

  it("clears the login once, with the cleanup authorization", async () => {
    vi.mocked(installRuntimeLogin).mockResolvedValue({
      ok: true,
      installId: "install-1",
      login: { accessToken: "cursor-access", expiresAt: EXPIRES_AT },
    });
    const opened = await openTurnCredential(args());
    if (!opened.ok) throw new Error(opened.message);
    await Promise.all([opened.credential.revoke(), opened.credential.revoke()]);
    expect(clearRuntimeLogin).toHaveBeenCalledTimes(1);
    expect(clearRuntimeLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        installId: "install-1",
        bearer: "fresh-bearer",
        harnessId: "cursor",
      }),
    );
    expect(revokeHarnessModelBroker).not.toHaveBeenCalled();
  });

  it("refuses the turn, before anything spawns, when no login comes back", async () => {
    vi.mocked(installRuntimeLogin).mockResolvedValue({
      ok: false,
      message:
        "Ask an org admin to add a Cursor key in Organization → AI providers.",
    });
    await expect(openTurnCredential(args())).resolves.toEqual({
      ok: false,
      status: "login-unavailable",
      message:
        "Ask an org admin to add a Cursor key in Organization → AI providers.",
    });
  });
});
