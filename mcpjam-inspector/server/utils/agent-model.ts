import { validateModelSelection } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import {
  MCPJAM_AGENT_BILLING_FEATURE,
  MCPJAM_AGENT_MODEL_DEFINITION,
  MCPJAM_AGENT_MODEL_SELECTION,
} from "@/shared/mcpjam-agent-model";
import {
  buildSyntheticModelDefinition,
  orgRequiresOwnKeys,
  resolveOrgModelConfig,
} from "./org-model-config";
import { WebRouteError, ErrorCode } from "../routes/web/errors";

/** The server chooses the agent's model; a caller never chooses a paid model. */
export async function resolveAgentModel(args: {
  projectId: string;
  authHeader?: string;
  isGuest: boolean;
}) {
  const platform = {
    modelDefinition: MCPJAM_AGENT_MODEL_DEFINITION,
    routingSelection: MCPJAM_AGENT_MODEL_SELECTION,
    billingFeature: args.isGuest ? undefined : MCPJAM_AGENT_BILLING_FEATURE,
  };
  if (args.isGuest || !process.env.CONVEX_HTTP_URL) return platform;
  const config = await resolveOrgModelConfig(
    { projectId: args.projectId },
    { authHeader: args.authHeader },
  );
  if (!orgRequiresOwnKeys(config)) return platform;
  const checked = validateModelSelection(config.defaultModel);
  if (!checked.ok || checked.selection.source !== "org") {
    throw new WebRouteError(
      422,
      ErrorCode.VALIDATION_ERROR,
      "Ask MCPJam needs an organization default model. Choose one in Organization → AI providers.",
      { code: "org_model_unconfigured", isRetryable: false },
    );
  }
  const modelDefinition: ModelDefinition = buildSyntheticModelDefinition(
    checked.selection.modelId,
    { hosted: false },
  );
  return {
    modelDefinition,
    routingSelection: checked.selection,
    billingFeature: undefined,
  };
}
