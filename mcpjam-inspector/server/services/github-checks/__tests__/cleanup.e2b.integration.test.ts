import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { describe, expect, it } from "vitest";
import {
  executeClaimedCheck,
  type CheckExecutionDeps,
  type ClaimedGithubCheck,
} from "../../github-checks-worker";
import type { CheckPlanSession } from "../check-plan";
import {
  GITHUB_CHECKS_EGRESS_DENY_CIDRS,
  killCheckSandbox,
  provisionCheckSandbox,
  type CheckSandbox,
} from "../sandbox";

// Opt in with `npm run test:github-checks-cleanup:e2b -w @mcpjam/inspector`.
// The normal suite skips these paid, credentialed sandboxes.

const RUN = process.env.RUN_GITHUB_CHECKS_E2B_CLEANUP === "1";
const API_KEY = process.env.E2B_API_KEY?.trim();
const TEMPLATE_ID = process.env.GITHUB_CHECKS_E2B_TEMPLATE_ID?.trim();
const VERIFY_POLL_MS = 1_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sandboxExists(triggerId: string, sandboxId: string) {
  const paginator = Sandbox.list({
    apiKey: API_KEY,
    query: { metadata: { triggerId } },
    limit: 100,
    requestTimeoutMs: 10_000,
  });
  while (paginator.hasNext) {
    const page = await paginator.nextItems({ requestTimeoutMs: 10_000 });
    if (page.some((sandbox) => sandbox.sandboxId === sandboxId)) return true;
  }
  return false;
}

async function waitForSandboxAbsent(
  triggerId: string,
  sandboxId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!(await sandboxExists(triggerId, sandboxId))) return;
    if (Date.now() >= deadline) {
      throw new Error(`sandbox ${sandboxId} still exists after ${timeoutMs}ms`);
    }
    await sleep(VERIFY_POLL_MS);
  }
}

async function emergencyCleanup(
  scenario: string,
  sandboxId: string | undefined,
  verifiedAbsent: boolean,
): Promise<void> {
  console.info(
    "[github-checks-cleanup-e2b]",
    JSON.stringify({ scenario, sandboxId, verifiedAbsent }),
  );
  if (!sandboxId || !API_KEY) return;
  try {
    await Sandbox.kill(sandboxId, { apiKey: API_KEY, requestTimeoutMs: 10_000 });
  } catch (error) {
    console.warn("[github-checks-cleanup-e2b] emergency cleanup failed", {
      scenario,
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireLiveConfiguration(): void {
  if (!API_KEY || !TEMPLATE_ID) {
    throw new Error(
      "RUN_GITHUB_CHECKS_E2B_CLEANUP requires E2B_API_KEY and GITHUB_CHECKS_E2B_TEMPLATE_ID",
    );
  }
}

const baseClaim: ClaimedGithubCheck = {
  triggerId: "replaced-per-scenario",
  repoFullName: "mcpjam/e2b-cleanup-fixture",
  prNumber: 1,
  headSha: "a".repeat(40),
  organizationId: "cleanup-org",
  projectId: "cleanup-project",
  createdByExternalId: "cleanup-user",
  suiteId: "cleanup-suite",
  repoPrivate: false,
  credentialPolicyVersion: 2,
  isFork: false,
  githubCredentialPolicy: "same_repository",
  allowedBuiltInToolIds: [],
};

function liveDeps(
  scenario: string,
  created: string[],
): Partial<CheckExecutionDeps> {
  const session: CheckPlanSession = {
    planId: `cleanup-plan-${scenario}`,
    candidates: async () => ({
      candidates: [],
      stopPolicy: { maxCandidates: 1, wallClockMs: 60_000 },
    }),
    attempt: async (input) => ({
      action: input.phase === "eval" && input.ok ? "complete" : "continue_phase",
    }),
    complete: async () => {},
  };
  return {
    beginPlan: async () => session,
    credentialPreflight: async (_claim, _claimedBy, mint) =>
      mint ? "synthetic-execution-bearer" : null,
    resolveAndStart: async (args, overrides) => {
      const sandbox = await provisionCheckSandbox({
        triggerId: args.triggerId,
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
      });
      created.push(sandbox.sandboxId);
      overrides.onSandbox?.(sandbox);
      return {
        sandbox,
        recipe: {
          build: "true",
          start: "true",
          port: 3001,
          mcpPath: "/mcp",
          rung: "override",
          ownershipProof: "verified",
          evidence: ["synthetic cleanup fixture"],
        },
        candidateId: "cleanup-candidate",
        started: {
          url: `https://${sandbox.getHost(3001)}/mcp`,
          readStderrTail: async () => "",
          spawn: { pid: 1, pgrp: 1 },
        },
        provenance: {
          recipeRung: "override",
          recipeEvidence: ["synthetic cleanup fixture"],
        },
      };
    },
    killSandbox: killCheckSandbox,
    getBearer: async () => "synthetic-control-bearer",
    createEphemeralServer: async () => "synthetic-server",
    deleteEphemeralServer: async () => {},
    recordServer: async () => {},
    reportCredentialBlocked: async () => {},
    report: async () => {},
    heartbeat: async () => {},
    heartbeatIntervalMs: 60_000,
    cleanupTimeoutMs: 15_000,
    runConformance: async () => ({ runId: "synthetic-conformance" }),
  };
}

describe.skipIf(!RUN)("GitHub-check sandbox cleanup — real E2B", () => {
  it.each([
    ["normal", "passed"],
    ["cancellation", "cancelled"],
    ["timeout", "timed_out"],
  ])(
    "removes the sandbox after %s",
    async (scenario, result) => {
      requireLiveConfiguration();
      const triggerId = `cleanup-${scenario}-${randomUUID()}`;
      const created: string[] = [];
      let verifiedAbsent = false;
      try {
        await executeClaimedCheck(
          { ...baseClaim, triggerId },
          "cleanup-worker",
          {
            ...liveDeps(scenario, created),
            runEvalSuite: async (args) => {
              await args.onRunStarted?.(`cleanup-run-${scenario}`);
              return { runId: `cleanup-run-${scenario}`, result };
            },
          },
        );
        expect(created).toHaveLength(1);
        await waitForSandboxAbsent(triggerId, created[0], 60_000);
        verifiedAbsent = true;
      } finally {
        await emergencyCleanup(scenario, created[0], verifiedAbsent);
      }
    },
    75_000,
  );

  it(
    "removes the sandbox after execution fails",
    async () => {
      requireLiveConfiguration();
      const scenario = "execution_failure";
      const triggerId = `cleanup-${scenario}-${randomUUID()}`;
      const created: string[] = [];
      let verifiedAbsent = false;
      try {
        await executeClaimedCheck(
          { ...baseClaim, triggerId },
          "cleanup-worker",
          {
            ...liveDeps(scenario, created),
            runEvalSuite: async () => {
              throw new Error("synthetic execution failure");
            },
          },
        );
        expect(created).toHaveLength(1);
        await waitForSandboxAbsent(triggerId, created[0], 60_000);
        verifiedAbsent = true;
      } finally {
        await emergencyCleanup(scenario, created[0], verifiedAbsent);
      }
    },
    75_000,
  );

  it(
    "E2B reaps an orphan after the fixture-only lifetime",
    async () => {
      requireLiveConfiguration();
      const scenario = "worker_death";
      const triggerId = `cleanup-${scenario}-${randomUUID()}`;
      let sandbox: CheckSandbox | undefined;
      let verifiedAbsent = false;
      try {
        sandbox = (await Sandbox.create(TEMPLATE_ID!, {
          apiKey: API_KEY!,
          timeoutMs: 60_000,
          lifecycle: { onTimeout: "kill" },
          network: {
            allowPublicTraffic: true,
            denyOut: [...GITHUB_CHECKS_EGRESS_DENY_CIDRS],
          },
          metadata: {
            purpose: "github-checks-cleanup-fixture",
            triggerId,
            scenario,
          },
        })) as unknown as CheckSandbox;
        await waitForSandboxAbsent(triggerId, sandbox.sandboxId, 90_000);
        verifiedAbsent = true;
      } finally {
        await emergencyCleanup(scenario, sandbox?.sandboxId, verifiedAbsent);
      }
    },
    105_000,
  );
});
