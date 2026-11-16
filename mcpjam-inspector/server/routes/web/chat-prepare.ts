import { Hono } from "hono";
import { resolveManagedTurnSetup } from "../../services/chat-turn/managed-setup.js";
import { TurnResources } from "../../services/chat-turn/resources.js";
import { prepareTurnAuthorization } from "../../services/chat-turn/turn-authorization.js";
import { environmentSelectsSecretDelivery } from "../../utils/harness/environment-secret-delivery.js";
import { canProvisionHarnessBoxes } from "../../utils/harness/harness-box.js";
import {
  harnessPrepareBoxEnabled,
  harnessPrepareBoxSwitchedOn,
} from "../../utils/harness/harness-flags.js";
import { OrgLeaseTurn } from "../../utils/harness/org-lease-turn.js";
import { playgroundHarnessBoxReason } from "../../utils/harness/playground-box.js";
import {
  isPreparableHarness,
  prepareConversationBox,
  type BoxPreparationOutcome,
} from "../../utils/harness/prepare-conversation-box.js";
import { logger } from "../../utils/logger.js";
import { forwardableSelection } from "../../utils/selection-rail.js";
import { assertBearerToken, readJsonBody } from "./errors.js";
import { createHostedRpcLogCollector } from "./hosted-rpc-logs.js";

const chatPrepare = new Hono();

type Skip = Extract<BoxPreparationOutcome, { outcome: "skipped" }>["reason"];

/**
 * Prepare a new hosted Claude Code or Codex chat's computer while its first
 * message is typed (`prepare-conversation-box.ts`), after the turn's own setup
 * up to the box: the same project and turn authorization, the same client and
 * environment resolution. Answers a closed outcome, which the client ignores;
 * a setup the turn route would refuse is refused the same way here.
 */
chatPrepare.post("/prepare", async (c) => {
  const skip = (reason: Skip) =>
    c.json({ outcome: "skipped", reason } satisfies BoxPreparationOutcome);
  if (!harnessPrepareBoxSwitchedOn()) return skip("disabled");
  const bearerToken = assertBearerToken(c);
  // No message exists yet; nothing in the setup may read one.
  const rawBody = {
    ...(await readJsonBody<Record<string, unknown>>(c)),
    messages: [],
  };
  const setup = await resolveManagedTurnSetup({
    c,
    rawBody,
    bearerToken,
    localIngress: false,
    rpcCollector: createHostedRpcLogCollector(rawBody),
    preparation: true,
  });
  if (!setup.value) return skip("not_eligible");
  const {
    authorizedOrganizationId,
    hostedBody,
    resolvedExecution,
    turnMode,
    harnessExecutionTarget,
    environmentSpec,
    pinsEnvironment,
    executionTarget,
    modelDefinition,
    routingSelection,
  } = setup.value;
  const harness = resolvedExecution.harness;
  const chatSessionId = hostedBody.chatSessionId;
  if (!harnessPrepareBoxEnabled(authorizedOrganizationId)) {
    return skip("disabled");
  }
  if (
    !isPreparableHarness(harness) ||
    !chatSessionId ||
    turnMode !== "interactive" ||
    playgroundHarnessBoxReason({
      harnessId: harness,
      localExecution: Boolean(harnessExecutionTarget),
      isScenarioSession: false,
      comparePane: hostedBody.comparePane === true,
    }) !== "conversation" ||
    !canProvisionHarnessBoxes()
  ) {
    return skip("not_eligible");
  }
  // The Send would hand this environment's plaintext secrets to the box.
  const environmentId = environmentSpec?.environmentRef.environmentId;
  if (
    environmentId &&
    (await environmentSelectsSecretDelivery(
      bearerToken,
      { projectId: hostedBody.projectId, environmentId },
      "materialized",
    ))
  ) {
    return skip("materialized_secrets");
  }
  const resources = new TurnResources(() => {
    logger.warn("[harness-prepare] authorization cleanup failed");
  });
  try {
    const turnAuthorization = await prepareTurnAuthorization(
      c,
      {
        projectId: hostedBody.projectId,
        chatSessionId,
        executionTarget,
        harness,
        ...(hostedBody.harnessStartupRequestId
          ? { requestId: hostedBody.harnessStartupRequestId }
          : {}),
      },
      resources,
    );
    const authorization =
      turnAuthorization?.getAuthorization ??
      (async () => `Bearer ${bearerToken}`);
    const modelSelection = forwardableSelection(routingSelection);
    return c.json(
      await prepareConversationBox({
        harnessId: harness,
        projectId: hostedBody.projectId,
        chatSessionId,
        // The box carries the environment's grant exactly when the Send's would.
        ...(pinsEnvironment && environmentId
          ? { projectEnvironmentId: environmentId }
          : {}),
        modelId: new OrgLeaseTurn({
          harness,
          ...(modelSelection ? { modelSelection } : {}),
        }).modelId(String(modelDefinition.id), modelDefinition.provider),
        bearer: bearerToken,
        authorization,
        cleanupAuthorization:
          turnAuthorization?.getCleanupAuthorization ?? authorization,
      }),
    );
  } finally {
    await resources.dispose();
  }
});

export default chatPrepare;
