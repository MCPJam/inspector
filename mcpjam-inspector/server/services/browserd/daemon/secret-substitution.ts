/**
 * Substitutes a secret's value into an act at the last moment. The recorded
 * action (ledger, `/v1/trace`, mirror) keeps its `{{secret:NAME}}`
 * placeholders; the values travel beside the command.
 *
 * Throws on an unresolved placeholder: callers other than the planner reach
 * `execute`, and typing a literal placeholder would look like a wrong password.
 */
import type { BrowserAction } from "../protocol";
import { formatBrowserdError } from "../protocol";
import { substituteSecrets } from "../../../utils/secrets/secret-placeholders";

type ActAction = Extract<BrowserAction, { kind: "act" }>;

/**
 * Returns the original object when nothing was substituted; the caller uses
 * that identity to decide whether to register secrets.
 */
export function resolveActSecrets(
  action: ActAction,
  secrets: ReadonlyArray<{ name: string; value: string }> | undefined,
): ActAction {
  const values = new Map((secrets ?? []).map((s) => [s.name, s.value]));
  const value =
    action.value === undefined
      ? undefined
      : substituteSecrets(action.value, values);
  const fields = action.fields?.map((field) =>
    typeof field.value === "string"
      ? { ...field, value: substituteSecrets(field.value, values) }
      : field,
  );
  // A `null` from `substituteSecrets` is "a placeholder had no value".
  if (value === null || fields?.some((field) => field.value === null)) {
    throw new Error(
      formatBrowserdError(
        "secret_unresolved",
        "this act referenced a {{secret:NAME}} the browser was not given a " +
          "value for; nothing was typed. Check the name, and that the secret " +
          "is set for this environment.",
      ),
    );
  }
  const valueChanged = value !== undefined && value !== action.value;
  const fieldsChanged =
    fields !== undefined &&
    fields.some((field, index) => field.value !== action.fields?.[index]?.value);
  if (!valueChanged && !fieldsChanged) return action;
  return {
    ...action,
    ...(value === undefined ? {} : { value }),
    ...(fields === undefined
      ? {}
      : { fields: fields as NonNullable<ActAction["fields"]> }),
  };
}
