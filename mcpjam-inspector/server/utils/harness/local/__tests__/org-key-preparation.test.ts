import { describe, expect, it, vi } from "vitest";
import { prepareLocalOnOrgKey } from "../org-key-preparation";
import { stampOrgCredentialRevision } from "../../org-credential-continuity";
import type {
  LocalHarnessTurnPreparation,
  PreparedLocalHarnessTurn,
} from "../local-turn";

function preparedOn(revision: string | undefined): PreparedLocalHarnessTurn {
  return {
    teardown: vi.fn(async () => {}),
    ...(revision
      ? {
          orgUpstream: {
            credentialSource: "org",
            profile: "anthropic-native",
            nativeModelId: "claude-sonnet-4-6",
            credentialRevision: revision,
          },
        }
      : {}),
  } as Partial<PreparedLocalHarnessTurn> as PreparedLocalHarnessTurn;
}

/** Each preparation's lease names the next revision. */
function preparing(...revisions: Array<string | undefined>) {
  const prepared = revisions.map(preparedOn);
  let next = 0;
  const prepare = vi.fn(
    async (_sessionId: string): Promise<LocalHarnessTurnPreparation> => ({
      ok: true,
      prepared: prepared[next++]!,
    }),
  );
  return { prepare, prepared };
}

const stampedState = (revision: string) => ({
  state: { resumeState: stampOrgCredentialRevision({}, revision) },
});

const base = {
  sessionId: "local-session",
  onOrgKey: true,
  resumes: true,
  isApprovalResume: false,
  runOwnsSession: false,
};

describe("prepareLocalOnOrgKey", () => {
  it("keeps the session when the key is the one the state was produced on", async () => {
    const { prepare } = preparing("rev_a");
    const result = await prepareLocalOnOrgKey({
      ...base,
      prepare,
      continuity: stampedState("rev_a"),
      stampedRevision: "rev_a",
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      sessionId: "local-session",
      keyReplaced: false,
    });
  });

  it("prepares again under a fresh id when the key was replaced", async () => {
    const { prepare, prepared } = preparing("rev_b", "rev_b");
    const result = await prepareLocalOnOrgKey({
      ...base,
      prepare,
      continuity: stampedState("rev_a"),
      stampedRevision: "rev_a",
    });
    expect(prepared[0]!.teardown).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.keyReplaced).toBe(true);
    expect(result.sessionId).toMatch(/^local-/);
    expect(result.sessionId).not.toBe("local-session");
    expect(prepare.mock.calls[1]![0]).toBe(result.sessionId);
    expect(result.prepared).toBe(prepared[1]);
  });

  it("refuses a lease that does not confirm the org binding", async () => {
    const { prepare, prepared } = preparing(undefined);
    await expect(
      prepareLocalOnOrgKey({
        ...base,
        prepare,
        continuity: null,
        stampedRevision: undefined,
      }),
    ).rejects.toThrow(/did not confirm a lease/);
    expect(prepared[0]!.teardown).toHaveBeenCalledOnce();
  });

  it("fails a failed preparation with its status", async () => {
    const prepare = vi.fn(async (): Promise<LocalHarnessTurnPreparation> => ({
      ok: false,
      status: "runtime-missing",
      message: "Install the runtime.",
    }));
    await expect(
      prepareLocalOnOrgKey({
        ...base,
        prepare,
        continuity: null,
        stampedRevision: undefined,
      }),
    ).rejects.toThrow(
      "Can't run this turn on your machine (runtime-missing): Install the runtime.",
    );
  });

  it("a hosted-key turn never compares revisions", async () => {
    const { prepare } = preparing(undefined);
    const result = await prepareLocalOnOrgKey({
      ...base,
      onOrgKey: false,
      prepare,
      continuity: stampedState("rev_a"),
      stampedRevision: undefined,
    });
    expect(result.keyReplaced).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
  });
});
