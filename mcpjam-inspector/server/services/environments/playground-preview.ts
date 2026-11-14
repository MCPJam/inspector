import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { readRuntimeModelChoice } from "../../utils/runtime-model-choice.js";
import {
  runtimeSelectors,
  toEnvironmentPreview,
  type EnvironmentSkillDelivery,
  type ResolvedEnvironmentRuntime,
} from "./runtime.js";
import { turnRuntime } from "./turn-skills.js";

/** Only the public preview and the turn reader's validated model choice cross
 * the browser boundary. The saved label itself can never be copied here. */
export function toPlaygroundEnvironmentPreview(
  spec: ResolvedEnvironmentRuntime,
) {
  const preview = toEnvironmentPreview(spec, {
    skillDelivery: skillDelivery(spec),
  });
  try {
    const { selection } = readRuntimeModelChoice(spec.host.runtimeConfig);
    return {
      ...preview,
      host: { ...preview.host, modelSelection: selection ?? null },
    };
  } catch {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "The saved model or connection is invalid. Update this setup before sending.",
    );
  }
}

/**
 * How a turn on this environment takes its skills: the engine its skill plan
 * runs on (`turnRuntime`), and whether that engine has a skill channel, which
 * is what the plan checks before it puts anything on a harness's box.
 */
function skillDelivery(
  spec: ResolvedEnvironmentRuntime,
): EnvironmentSkillDelivery {
  const runtime = turnRuntime(runtimeSelectors(spec.host.runtimeConfig));
  if (runtime.kind === "agent") return "emulated";
  return harnessSupportsSkills(runtime.harnessId) ? "harness" : "unsupported";
}
