import { useId, type Dispatch, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { FieldError } from "@mcpjam/design-system/field-error";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import { SuiteSettingsRow } from "../suite-settings-row";
import type {
  SuiteSettingsAction,
  SuiteSettingsDraft,
} from "../suite-settings-draft";
import { readOnlyNote, type CodeGradingGate } from "./code-grading-flags";
import {
  gradingFileHints,
  hasGrading,
  withGradingFiles,
  withGradingNetwork,
  type SuiteGrading,
} from "./code-grading-values";
import { SCRIPT_TEXT_CLASS } from "./setup-cleanup-row";

export const GRADING_HINT =
  "Code evaluators run in a grading box of their own. Choose the files it gets from the agent's box, and whether it can reach the web.";

/**
 * "Grading" on the Default evaluators tab: what the grading box gets, saved
 * through the settings draft as one `grading` object. Without its flag the
 * row shows what the suite holds, read-only, and can still clear it.
 */
export function GradingRow({
  draft,
  dispatch,
  gate,
  accessory,
}: {
  draft: SuiteSettingsDraft;
  dispatch: Dispatch<SuiteSettingsAction>;
  gate: CodeGradingGate;
  accessory?: ReactNode;
}) {
  const filesId = useId();
  const networkId = useId();
  const value = draft.current.grading;
  const stored = hasGrading(value) || hasGrading(draft.base.grading);
  if (!gate.canEdit && !gate.showEmpty && !stored) return null;

  const edit = (
    update: (previous: SuiteGrading | undefined) => SuiteGrading | undefined,
  ) => dispatch({ type: "edit", key: "grading", value: update });
  const files = value?.files ?? [];
  const web = value?.network === "web";
  const hints = gradingFileHints(files);
  const note = readOnlyNote(gate, stored ? "settings" : null);

  return (
    <SuiteSettingsRow
      settingKey="grading"
      chained={false}
      data-subsection-id="grading"
      hint={GRADING_HINT}
      accessory={accessory}
      {...(note ? { "data-read-only-reason": note } : {})}
    >
      <div className="space-y-5">
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
        {gate.canEdit || files.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label
                  htmlFor={filesId}
                  className="block text-sm font-medium text-foreground"
                >
                  Files to copy
                </label>
                <p
                  id={`${filesId}-note`}
                  className="text-xs text-muted-foreground"
                >
                  From the agent's box into the grading box, on runs where the
                  agent works in one. One path per line, up to 25 MB each.
                </p>
              </div>
              {gate.canEdit ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-label="Remove the files to copy"
                  onClick={() =>
                    edit((previous) => withGradingFiles(previous, ""))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </div>
            <Textarea
              id={filesId}
              value={files.join("\n")}
              readOnly={!gate.canEdit}
              spellCheck={false}
              placeholder="/home/user/app/report.json"
              aria-invalid={hints.length ? true : undefined}
              aria-describedby={
                hints.length
                  ? `${filesId}-note ${filesId}-hint`
                  : `${filesId}-note`
              }
              onChange={(event) =>
                edit((previous) =>
                  withGradingFiles(previous, event.target.value),
                )
              }
              className={cn(SCRIPT_TEXT_CLASS, "min-h-16 resize-y")}
            />
            <FieldError id={`${filesId}-hint`} className="text-xs">
              {hints.length ? hints.join(" ") : null}
            </FieldError>
          </div>
        ) : null}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label
              htmlFor={networkId}
              className="block text-sm font-medium text-foreground"
            >
              Network
            </label>
            <p
              id={`${networkId}-note`}
              className="text-xs text-muted-foreground"
            >
              {web
                ? "Evaluators can reach the web."
                : "Evaluators can't reach the network."}
            </p>
          </div>
          <Switch
            id={networkId}
            aria-describedby={`${networkId}-note`}
            checked={web}
            // Read-only still turns it off: clearing is never gated.
            disabled={!gate.canEdit && !web}
            onCheckedChange={(on) =>
              edit((previous) => withGradingNetwork(previous, on))
            }
          />
        </div>
      </div>
    </SuiteSettingsRow>
  );
}
