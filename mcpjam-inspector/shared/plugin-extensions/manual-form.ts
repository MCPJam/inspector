import type { PluginFormProfile } from "./form-plan.js";

/** Manual inspection has no upload placement or app-preview owner. */
export const MANUAL_PLUGIN_FORM_PROFILE: PluginFormProfile = {
  origin: "server",
  userResources: false,
  previews: false,
};
