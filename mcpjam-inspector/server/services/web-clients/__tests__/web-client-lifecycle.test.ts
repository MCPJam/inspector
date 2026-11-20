/**
 * Web clients through the gates evals, swarms and compare already run: the
 * same admission a CLI runtime passes, no box, and no spend on MCPJam's key.
 */
import { describe, expect, it } from "vitest";
import { checkHarnessRuntimeAvailable } from "../../../utils/harness/harness-availability";
import {
  checkEvalHarnessStaticAdmission,
  resolveEvalCaseModelDefinition,
} from "../../evals/harness-admission";
import { needsEphemeralEvalSandbox } from "../../evals/needs-ephemeral-sandbox";

const HOSTS = [
  { harness: "claude-web", modelId: "anthropic/claude-sonnet-4.5", foreign: "openai/gpt-5.5" },
  { harness: "chatgpt-web", modelId: "openai/gpt-5.5", foreign: "anthropic/claude-sonnet-4.5" },
] as const;

describe.each(HOSTS)("$harness in the existing lifecycle", ({ harness, modelId, foreign }) => {
  it("is admitted to an eval run with servers, like any runtime", () => {
    expect(
      checkEvalHarnessStaticAdmission({
        hostConfig: { harness, modelId },
        serverIds: ["orders"],
      }),
    ).toEqual({ ok: true, harness });
  });

  it("boots no box for an iteration", () => {
    expect(needsEphemeralEvalSandbox({ harness, runId: "run-1" })).toEqual({
      needed: false,
      runtimeKind: "terminal",
    });
    expect(needsEphemeralEvalSandbox({ harness, runId: undefined }).needed).toBe(false);
  });

  it("runs a case on the project's web account, not MCPJam's key", () => {
    const caseModel = { id: modelId, name: modelId, provider: modelId.split("/")[0]! } as const;
    expect(
      resolveEvalCaseModelDefinition({ hostConfig: { harness, modelId }, caseModel }),
    ).toEqual({ modelDefinition: caseModel, externalAccount: true });
  });

  it("passes the swarm preflight without approval and refuses it with approval on", () => {
    const base = {
      harnessId: harness,
      surface: "swarms" as const,
      hasSelectedMcpServers: true,
      model: { id: modelId },
      purpose: "swarm" as const,
    };
    expect(checkHarnessRuntimeAvailable({ ...base, requireToolApproval: false })).toEqual({ ok: true });
    expect(checkHarnessRuntimeAvailable({ ...base, requireToolApproval: true })).toMatchObject({
      ok: false,
      kind: "tool-approval",
    });
  });

  it("refuses another vendor's model and the study and guest surfaces", () => {
    const base = { harnessId: harness, requireToolApproval: false, hasSelectedMcpServers: true };
    expect(
      checkHarnessRuntimeAvailable({ ...base, surface: "evals", model: { id: foreign } }),
    ).toMatchObject({ ok: false, kind: "model-unsupported" });
    expect(
      checkHarnessRuntimeAvailable({ ...base, surface: "user-testing", model: { id: modelId } }),
    ).toMatchObject({ ok: false, kind: "surface-unsupported" });
  });
});
