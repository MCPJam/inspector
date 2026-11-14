import {
  resolveModelContextPolicy,
  type ModelContextPolicyHostInput,
} from "@mcpjam/sdk/host-config/internal";

/** The saved client's App context budgets, read per request and never bound
 * to an open App, so saving the client changes the next update. */
export function pluginModelContextPolicy(
  config: { mcpProfile?: unknown } | null | undefined,
) {
  return resolveModelContextPolicy(config as ModelContextPolicyHostInput);
}

/** Fail closed until this partial prototype is explicitly enabled in the saved matrix.
 * Stock presets and OpenAI full-extension claims are migrated in their own slice.
 */
export function pluginModelContextEnabled(config: {
  mcpProfile?: unknown;
}): boolean {
  const profile = config.mcpProfile as
    | {
        profileVersion?: unknown;
        apps?: { mcpAppsOverrides?: { updateModelContext?: unknown } };
      }
    | undefined;
  return (
    profile?.profileVersion === 1 &&
    profile.apps?.mcpAppsOverrides?.updateModelContext === true
  );
}

/** Partial message service including inert link text; never a full OpenAI claim. */
export function pluginMessageEnabled(config: {
  mcpProfile?: unknown;
}): boolean {
  const profile = config.mcpProfile as
    | {
        profileVersion?: unknown;
        apps?: { mcpAppsOverrides?: { message?: unknown } };
      }
    | undefined;
  return (
    profile?.profileVersion === 1 &&
    profile.apps?.mcpAppsOverrides?.message === true
  );
}
