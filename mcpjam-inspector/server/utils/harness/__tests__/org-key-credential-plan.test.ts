import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The org-key credential plan for an EXTERNAL-ACCOUNT harness (Cursor): the
 * backend says whether the organization's key is ready, and the box only ever
 * gets a placeholder. The failure this guards against is a turn that STARTS
 * without a usable key, so every non-ready answer, and every answer that can't
 * be read, must refuse.
 */
const readinessState = vi.hoisted(() => ({
  answer: null as unknown,
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../computers/control-plane-client.js", () => ({
  getHarnessCredentialReadiness: vi.fn(
    async (args: Record<string, unknown>) => {
      readinessState.calls.push(args);
      return readinessState.answer;
    },
  ),
}));

const loggerState = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { warn: loggerState.warn, info: vi.fn(), error: vi.fn() },
}));

import {
  EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER,
  ExternalAccountCredentialRefusal,
  resolveOrgKeyCredentialPlan,
} from "../external-account-credentials";
import { ORG_KEY_MISSING_MESSAGE } from "@/shared/org-key-surfaces";

const CURSOR = {
  id: "cursor",
  modelAccess: "external-account",
  externalAccountCredentialEnv: ["CURSOR_API_KEY"],
};
const ask = (overrides: Record<string, unknown> = {}) => ({
  harness: CURSOR,
  bearer: "Bearer member-token",
  projectId: "project-1",
  ...overrides,
});
const answer = (readiness: string) => ({ ok: true, value: { readiness } });

afterEach(() => {
  readinessState.answer = null;
  readinessState.calls = [];
  loggerState.warn.mockClear();
});

describe("resolveOrgKeyCredentialPlan", () => {
  it("hands the adapter only the placeholder when the org key is ready", async () => {
    readinessState.answer = answer("ready");
    const plan = await resolveOrgKeyCredentialPlan(ask());
    expect(plan).toEqual({
      auth: { CURSOR_API_KEY: "" },
    });
    expect(EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER).toBe(
      "mcpjam-brokered-credential",
    );
    // Asked for the project and harness on the member's bearer, nothing else.
    expect(readinessState.calls).toEqual([
      {
        bearer: "Bearer member-token",
        projectId: "project-1",
        harnessId: "cursor",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it.each(["missing", "invalid"])(
    "refuses with the admin copy when readiness is %s",
    async (readiness) => {
      readinessState.answer = answer(readiness);
      const result = resolveOrgKeyCredentialPlan(ask());
      await expect(result).rejects.toBeInstanceOf(
        ExternalAccountCredentialRefusal,
      );
      await expect(result).rejects.toThrow(
        "Ask an org admin to add a Cursor key in Organization → AI providers.",
      );
      expect(ORG_KEY_MISSING_MESSAGE).toBe(
        "Ask an org admin to add a Cursor key in Organization → AI providers.",
      );
    },
  );

  it.each([
    ["the backend predates the route", { ok: false, status: 404 }],
    ["the backend is unreachable", { ok: false, status: 0 }],
    ["the bearer is refused", { ok: false, status: 403 }],
  ])("refuses, never guessing ready, when %s", async (_label, failure) => {
    readinessState.answer = { ...failure, error: "x" };
    await expect(resolveOrgKeyCredentialPlan(ask())).rejects.toThrow(
      "Couldn't check your organization's Cursor key. Try again in a moment.",
    );
    expect(loggerState.warn).toHaveBeenCalledWith(
      expect.stringContaining("readiness unavailable"),
      { status: failure.status },
    );
    expect(JSON.stringify(loggerState.warn.mock.calls)).not.toContain(
      "member-token",
    );
  });

  it("tells a GitHub check its approval doesn't cover the run, without asking for a retry", async () => {
    // The backend's answer when a check's approved credentials don't include
    // the org key: retrying can never succeed, so the copy says what to do.
    readinessState.answer = {
      ok: false,
      status: 403,
      error: "x",
      code: "credential_policy_blocked",
    };
    await expect(resolveOrgKeyCredentialPlan(ask())).rejects.toThrow(
      "This GitHub check is blocked by its approved credential policy. Approve the current commit again to run it.",
    );
  });

  it("refuses without a bearer or a project, and asks nothing", async () => {
    await expect(
      resolveOrgKeyCredentialPlan(ask({ bearer: undefined })),
    ).rejects.toBeInstanceOf(ExternalAccountCredentialRefusal);
    await expect(
      resolveOrgKeyCredentialPlan(ask({ projectId: undefined })),
    ).rejects.toBeInstanceOf(ExternalAccountCredentialRefusal);
    expect(readinessState.calls).toEqual([]);
  });

  it("is undefined for a harness that needs no external credential", async () => {
    expect(
      await resolveOrgKeyCredentialPlan(
        ask({ harness: { id: "claude-code", modelAccess: "broker" } }),
      ),
    ).toBeUndefined();
    expect(readinessState.calls).toEqual([]);
  });
});
