/**
 * Which backend a recoverable turn acts through: the one for the person the
 * turn's environment acts as, or none, in which case the turn runs as it
 * would without recovery.
 */
import { describe, expect, it, vi } from "vitest";

const ran = vi.hoisted(() =>
  vi.fn(async () => ({ ok: false as const, turnId: "turn-1" })),
);
vi.mock("../../run-web-client-turn.js", () => ({ runWebClientTurn: ran }));

import type { WebClientTurnInput } from "../../run-web-client-turn.js";
import { createInMemoryWebReconnectBackend } from "../in-memory-backend.js";
import {
  runRecoverableWebTurn,
  type WebRecoverySetup,
} from "../turn-recovery.js";

const ledger = { find: async () => [], forTurn: async () => [] };

function turn(actor?: { actorExternalId: string }): WebClientTurnInput {
  return {
    runtimeId: "chatgpt-web",
    projectId: "project-1",
    runId: "run-1",
    environment: { ...(actor ? { actor } : {}) },
  } as unknown as WebClientTurnInput;
}

describe("runRecoverableWebTurn", () => {
  it("asks for the backend of the person the turn acts as", async () => {
    const backendFor = vi.fn<WebRecoverySetup["backendFor"]>(() => undefined);
    await runRecoverableWebTurn(turn({ actorExternalId: "user_admin" }), {
      backendFor,
      ledger,
    });
    expect(backendFor).toHaveBeenCalledWith({
      projectId: "project-1",
      runId: "run-1",
      actor: { actorExternalId: "user_admin" },
    });
  });

  it("runs the turn once, without recovery, when there is no backend to act through", async () => {
    ran.mockClear();
    const input = turn();
    const result = await runRecoverableWebTurn(input, {
      backendFor: () => undefined,
      ledger,
    });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(ran).toHaveBeenCalledWith(input);
    expect(result).toEqual({ ok: false, turnId: "turn-1" });
  });

  it("names the eval iteration on the sign-in request it opens", async () => {
    ran.mockResolvedValueOnce({
      ok: false,
      turnId: "turn-1",
      startedAt: Date.UTC(2026, 10, 20, 10),
      failure: {
        kind: "needs_sign_in",
        reason: "signed_out",
        step: "sign_in_check",
        message: "Signed out.",
      },
    } as never);
    const backend = createInMemoryWebReconnectBackend([
      {
        webAccountId: "web-account-1",
        projectId: "project-1",
        vendor: "chatgpt",
        status: "ready",
        profileVersion: 1,
      },
    ]);
    const report = vi.spyOn(backend, "reportWebSignInRequired");
    const input = {
      ...turn({ actorExternalId: "user_admin" }),
      iterationId: "iteration-7",
      environment: {
        actor: { actorExternalId: "user_admin" },
        resolveAccount: async () => ({ webAccountId: "web-account-1" }),
      },
    } as unknown as WebClientTurnInput;
    const result = await runRecoverableWebTurn(input, {
      backendFor: () => backend,
      ledger,
      maxPauseMs: 30,
      pollMs: 10,
    });
    expect(result).toMatchObject({
      ok: false,
      stop: { kind: "paused_for_person" },
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", iterationId: "iteration-7" }),
    );
  });
});
