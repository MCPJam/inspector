import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { readRuntimeModelChoice } from "../../utils/runtime-model-choice.js";
import {
  toEnvironmentPreview,
  type ResolvedEnvironmentRuntime,
} from "./runtime.js";

/** Only the public preview and the turn reader's validated model choice cross
 * the browser boundary. The saved label itself can never be copied here. */
export function toPlaygroundEnvironmentPreview(
  spec: ResolvedEnvironmentRuntime,
) {
  const preview = toEnvironmentPreview(spec, { harnessSupportsSkills });
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
