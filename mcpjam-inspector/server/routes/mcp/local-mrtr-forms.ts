import { selectElicitationFormSchema } from "@mcpjam/sdk";
import {
  compilePluginForm,
  pluginFormUnsupportedDiagnostic,
  validatePluginFormContent,
} from "../../../shared/plugin-extensions/form-plan.js";
import { MANUAL_PLUGIN_FORM_PROFILE } from "../../../shared/plugin-extensions/manual-form.js";

export function selectLocalMrtrForm(params?: Record<string, unknown>) {
  const selected = selectElicitationFormSchema(params, {
    extensionForms: true,
  });
  if (selected.kind === "unsupported")
    throw new Error("The requested extension form has no valid schema.", { cause: selected.reason });
  if (selected.source === "core") return { schema: selected.schema };
  // Refuse unsupported service-dependent fields before publishing any form.
  try {
    const plan = compilePluginForm(selected.schema, MANUAL_PLUGIN_FORM_PROFILE);
    return { schema: plan.schema, pluginForm: true as const };
  } catch (error) {
    throw new Error(
      pluginFormUnsupportedDiagnostic(error, selected.schema).description,
      { cause: error },
    );
  }
}

export function selectLocalMrtrSchema(params?: Record<string, unknown>) {
  return selectLocalMrtrForm(params).schema;
}

export function validateLocalMrtrAnswer(schema: unknown, content: unknown) {
  return validatePluginFormContent(
    compilePluginForm(schema, MANUAL_PLUGIN_FORM_PROFILE),
    content,
  );
}
