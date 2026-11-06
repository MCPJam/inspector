import { randomUUID } from "node:crypto";
import type { ModelReasoningEffort, ModelSelection } from "@mcpjam/sdk/browser";
import { acquirePlaygroundHarnessBox } from "../../server/utils/harness/playground-box.js";
import {
  startHarnessModelBroker,
  revokeHarnessModelBroker,
} from "../../server/utils/harness/harness-model-broker.js";
import { buildBrokerDummyAuth } from "../../server/utils/harness/registry.js";

export type BaselineRequest = {
  projectId: string;
  chatSessionId: string;
  bearer: string;
  harnessId: "claude-code" | "codex";
  modelId: string;
  modelSelection?: ModelSelection;
  reasoningEffort?: ModelReasoningEffort;
  signal?: AbortSignal;
};

/** All lease operations run on the development host. The CLI receives only
 * the sandbox identity and the same placeholder environment as the Playground.
 * The caller waits for the measured turn to finish before releasing egress. */
export async function runGatewayBaseline<T>(
  request: BaselineRequest,
  runCli: (turn: {
    sandboxId: string;
    runId: string;
    environment: ReturnType<typeof buildBrokerDummyAuth>;
    signal: AbortSignal;
  }) => Promise<T>,
) {
  const expectedOrigin = process.env.HARN24_QA_CONVEX_SITE;
  if (
    process.env.ENVIRONMENT !== "dev" ||
    !expectedOrigin ||
    !/^https:\/\/[a-z0-9-]+\.convex\.site$/.test(expectedOrigin) ||
    process.env.CONVEX_HTTP_URL !== expectedOrigin
  ) {
    throw new Error(
      "Select the isolated development backend before requesting a CLI lease.",
    );
  }
  if (process.env.HARN24_QA_PROJECT_ID !== request.projectId)
    throw new Error(
      "Select the internal qualification project before requesting a CLI lease.",
    );
  const signal = request.signal ?? AbortSignal.timeout(180_000);
  const startedAt = performance.now();
  const acquired = await acquirePlaygroundHarnessBox({
    bearer: request.bearer,
    projectId: request.projectId,
    chatSessionId: request.chatSessionId,
    harness: request.harnessId,
    signal,
  });
  if (!acquired.ok)
    throw new Error("Could not acquire the development chat's terminal box.");
  const { box } = acquired;
  const leaseStartedAt = performance.now();
  const runId = randomUUID();
  try {
    const lease = await startHarnessModelBroker({
      box: { kind: "sandbox", sandboxRowId: box.binding.sandboxRowId },
      runId,
      harnessId: request.harnessId,
      modelId: request.modelId,
      modelSelection: request.modelSelection,
      reasoningEffort: request.reasoningEffort,
      bearer: request.bearer,
      signal,
    });
    if (!lease.ok || lease.runId !== runId)
      throw new Error("The development gateway refused this CLI turn.");
    const leaseMs = performance.now() - leaseStartedAt;
    const result = await runCli({
      runId,
      sandboxId: box.binding.sandboxId,
      environment: buildBrokerDummyAuth(
        request.harnessId,
        lease.proxyBaseUrl,
        true,
      ),
      signal,
    });
    return { result, leaseMs, boxMs: leaseStartedAt - startedAt };
  } finally {
    try {
      // Even a lost start response may have installed egress. Revoke by our
      // own run ID on a fresh signal before attempting another measured turn.
      const revoked = await revokeHarnessModelBroker({
        runId,
        bearer: request.bearer,
        signal: AbortSignal.timeout(15_000),
      });
      if (!revoked.ok || revoked.networkCleared !== true)
        throw new Error(
          "CLI lease cleanup is uncertain. Stop this box's benchmark.",
        );
    } finally {
      await box.release();
    }
  }
}
