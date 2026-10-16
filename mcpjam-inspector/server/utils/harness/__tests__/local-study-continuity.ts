import { describe, expect, it, vi } from "vitest";
import type { MCPJamHandlerOptions } from "../../mcpjam-stream-handler";
import type { ExecutionScope } from "../../execution-scope";
import {
  claimHarnessSessionState,
  commitHarnessSessionState,
  releaseHarnessSessionState,
  type HarnessSessionCommitPayload,
} from "../harness-session-state";
import { prepareLocalHarnessTurn } from "../local/local-turn";
import { runHarnessTurn } from "../run-harness-turn";

type Harness = "claude-code" | "codex";
interface Fixture {
  options(overrides: Partial<MCPJamHandlerOptions>): MCPJamHandlerOptions;
  selectHarness(harness: Harness): void;
  onStreamStart(callback: (() => void) | undefined): void;
  createdSessions(): readonly unknown[][];
  teardownCalls(): number;
  stoppedSessions(): number;
}
const scopes: ExecutionScope[] = [
  { kind: "project", projectId: "project-1" },
  {
    kind: "swarm",
    swarmId: "study-1",
    accessVersion: 2,
    projectId: "project-1",
    workspaceId: "workspace-1",
  },
];
function optionsFor(fixture: Fixture, harness: Harness, scope: ExecutionScope) {
  fixture.selectHarness(harness);
  const options = fixture.options({
    harness,
    modelId:
      harness === "codex" ? "openai/gpt-5.5" : "anthropic/claude-sonnet-4-6",
    provider: harness === "codex" ? "openai" : "anthropic",
    sourceType: "scenario",
    scenarioId: "study-1",
    chatSessionId: "study-conversation",
    scenarioParticipant: scope.kind === "swarm",
    executionScope: scope,
    requireToolApproval: true,
  });
  return {
    ...options,
    harnessExecutionTarget: {
      ...options.harnessExecutionTarget!,
      localStudySessionId: "reservation-1",
      localStudyKeyId: "registered-key-1",
      localSessionId: "isolated-study-session",
      study: {
        scenarioId: "study-1",
        accessVersion: 2,
        chatSessionId: "study-conversation",
      },
    },
  };
}
function expectedOwner(harness: Harness, scope: ExecutionScope) {
  return {
    ownerType: "scenario-chat",
    harnessId: harness,
    projectId: "project-1",
    chatSessionId: "study-conversation",
    scenarioId: "study-1",
    executionScope: scope,
    localStudySessionId: "reservation-1",
    machineId: "machine-1",
    keyId: "registered-key-1",
  };
}
function registerResumeTests(fixture: Fixture) {
  for (const harness of ["claude-code", "codex"] as const) {
    it.each(scopes)(
      `${harness} resumes its study state for $kind access`,
      async (scope) => {
        const commits: HarnessSessionCommitPayload[] = [];
        const options = optionsFor(fixture, harness, scope);
        options.onConversationComplete = async (_messages, _trace, commit) => {
          if (commit) commits.push(commit);
          return { outcome: "saved" };
        };
        await runHarnessTurn(options, "none");
        const first = commits[0];
        expect(first).toBeDefined();
        if (!first)
          throw new Error(
            "The first study turn did not produce an atomic commit",
          );
        const owner = expectedOwner(harness, scope);
        expect(claimHarnessSessionState).toHaveBeenCalledWith(
          expect.objectContaining({ owner }),
        );
        const { projectId: _projectId, ...commitOwner } = owner;
        expect(first).toMatchObject({
          ...commitOwner,
          expectedStateVersion: 1,
        });
        expect(commitHarnessSessionState).not.toHaveBeenCalled();
        vi.mocked(claimHarnessSessionState).mockResolvedValue({
          ok: true,
          stateVersion: 2,
          fingerprintChanged: false,
          state: {
            harnessSessionId: first.harnessSessionId,
            computerId: first.computerId,
            resumeState: first.resumeState,
          },
        });
        await runHarnessTurn(
          {
            ...options,
            messages: [
              ...options.messages,
              { role: "user", content: "Continue using the same file" },
            ],
          },
          "none",
        );
        expect(commits).toHaveLength(2);
        expect(commits[1]).toMatchObject({
          ...commitOwner,
          expectedStateVersion: 2,
          harnessSessionId: first.harnessSessionId,
        });
        expect(fixture.createdSessions()[1]).toEqual([
          { sessionId: first.harnessSessionId, resumeFrom: first.resumeState },
        ]);
        expect(prepareLocalHarnessTurn).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessionId: first.harnessSessionId,
            target: options.harnessExecutionTarget,
          }),
        );
        expect(fixture.teardownCalls()).toBe(2);
        expect(releaseHarnessSessionState).not.toHaveBeenCalled();
      },
    );
  }
}
function registerCancellationTests(fixture: Fixture) {
  for (const harness of ["claude-code", "codex"] as const) {
    it(`${harness} cancels only the claimed study session without advancing its transcript`, async () => {
      const scope = scopes[1];
      const controller = new AbortController();
      const persist = vi.fn(async () => ({ outcome: "saved" as const }));
      fixture.onStreamStart(() => controller.abort());
      await runHarnessTurn(
        {
          ...optionsFor(fixture, harness, scope),
          abortSignal: controller.signal,
          onConversationComplete: persist,
        },
        "none",
      );
      expect(fixture.createdSessions()).toHaveLength(1);
      expect(fixture.stoppedSessions()).toBeGreaterThan(0);
      expect(fixture.teardownCalls()).toBe(1);
      expect(releaseHarnessSessionState).toHaveBeenCalledWith(
        expect.objectContaining({ owner: expectedOwner(harness, scope) }),
      );
      expect(commitHarnessSessionState).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
  }
}
export function registerLocalStudyContinuityTests(fixture: Fixture) {
  describe("local study runner continuity", () => {
    registerResumeTests(fixture);
    registerCancellationTests(fixture);
  });
}
