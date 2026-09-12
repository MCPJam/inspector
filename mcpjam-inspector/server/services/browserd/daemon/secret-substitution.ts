/**
 * Putting a secret's VALUE into an act, at the last possible moment.
 *
 * The action that reached this daemon carries `{{secret:NAME}}` — and it is
 * that action, placeholders intact, which the ledger row, `/v1/trace` and the
 * durable mirror record. The value arrives beside the command rather than
 * inside it, and this is the only place the two meet.
 *
 * IT THROWS RATHER THAN PASSING A PLACEHOLDER THROUGH. The server's planner
 * refuses an unusable name before the command is even sent, but the planner is
 * not the only caller that can reach here: the `/v1` browser routes, the CLI,
 * and whatever is written next all go through `execute`. A daemon that typed a
 * literal `{{secret:GITHUB_PASSWORD}}` into somebody's login form would report
 * success, and the model would read the failure as a wrong password.
 */
import type { BrowserAction } from "../protocol";
import { formatBrowserdError } from "../protocol";
import { substituteSecrets } from "../../../utils/secrets/secret-placeholders";

type ActAction = Extract<BrowserAction, { kind: "act" }>;

/**
 * The same act with every placeholder replaced, or the act unchanged.
 *
 * Returns the ORIGINAL OBJECT when nothing was substituted, which the caller
 * uses as its "did anything resolve?" test — a fresh object on every act would
 * make that test meaningless and register secrets for commands that used none.
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
