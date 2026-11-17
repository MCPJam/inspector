import { PLUGIN_ERROR_DESCRIPTIONS } from "./plugin-diagnostics";

/**
 * The closed vocabulary of `extension_operation_completed`: one outcome per
 * form response, Settings save or App message. The strict relay keeps only
 * these values, so an error code is always a code-owned catalog entry.
 */
export const EXTENSION_OPERATION_PROPERTIES = {
  location: ["host_workspace"],
  operation: ["form_response", "settings_save", "app_message"],
  host_profile: ["chatgpt", "codex", "unknown"],
  outcome: ["success", "failure", "declined", "cancelled"],
  deployment: ["hosted", "self_hosted"],
  source: ["client"],
} as const;

/** `none` on success, `refused` when the host turned the request down. */
export const EXTENSION_OPERATION_ERROR_CODES: readonly string[] = [
  "none",
  "refused",
  "other",
  ...Object.keys(PLUGIN_ERROR_DESCRIPTIONS),
];
