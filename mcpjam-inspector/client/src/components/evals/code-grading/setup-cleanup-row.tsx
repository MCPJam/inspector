import { useId, useState, type Dispatch, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { FieldError } from "@mcpjam/design-system/field-error";
import { Textarea } from "@mcpjam/design-system/textarea";
import { CloudUnreachableNotice } from "@/components/computer/CloudUnreachableNotice";
import { HOSTED_MODE } from "@/lib/config";
import { suiteOnMcpjamUrl } from "@/lib/eval-launch-reason";
import { SuiteSettingsRow } from "../suite-settings-row";
import type {
  SuiteSettingsAction,
  SuiteSettingsDraft,
} from "../suite-settings-draft";
import type { EvalSuite } from "../types";
import { readOnlyNote, type CodeGradingGate } from "./code-grading-flags";
import {
  SCRIPT_SLOTS,
  hasScripts,
  scriptSizeHint,
  totalSizeHint,
  withScript,
  type ScriptSlot,
  type SuiteScripts,
} from "./code-grading-values";

export const SETUP_CLEANUP_HINT =
  "Bash that runs in an MCPJam cloud sandbox, never on this machine. Setup can run for up to 5 minutes and cleanup for up to 2.";

/** Monospace with ligatures off: JetBrains Mono would draw `!=` as one glyph. */
export const SCRIPT_TEXT_CLASS =
  "font-code text-xs leading-relaxed [font-variant-ligatures:none] md:text-xs";

/**
 * "Setup and cleanup" on the Settings tab: four bash slots around the run and
 * each iteration, saved through the settings draft as one `scripts` object.
 * Without its flag the row lists what the suite holds, read-only, and keeps
 * the remove buttons, since the backend never gates clearing.
 */
export function SetupCleanupRow({
  suite,
  draft,
  dispatch,
  gate,
  runRefusal,
  accessory,
}: {
  suite: Pick<EvalSuite, "_id" | "codeEvaluators">;
  draft: SuiteSettingsDraft;
  dispatch: Dispatch<SuiteSettingsAction>;
  gate: CodeGradingGate;
  /** Why Run is off for this suite on this Inspector, when it is. */
  runRefusal?: string | null;
  accessory?: ReactNode;
}) {
  // Slots opened or edited here: an emptied slot stays open to type into.
  const [touched, setTouched] = useState<ReadonlySet<ScriptSlot>>(new Set());
  const scripts = draft.current.scripts;
  const saved = draft.base.scripts;
  const stored = hasScripts(scripts) || hasScripts(saved);
  if (!gate.canEdit && !gate.showEmpty && !stored) return null;

  const setTouchedSlot = (slot: ScriptSlot, on: boolean) =>
    setTouched((previous) => {
      const next = new Set(previous);
      if (on) next.add(slot);
      else next.delete(slot);
      return next;
    });
  const edit = (slot: ScriptSlot, text: string | undefined, open: boolean) => {
    setTouchedSlot(slot, open);
    dispatch({
      type: "edit",
      key: "scripts",
      value: (previous: SuiteScripts | undefined) =>
        withScript(previous, slot, text),
    });
  };
  const note = readOnlyNote(gate, stored ? "scripts" : null);
  const totalHint = totalSizeHint(scripts, suite.codeEvaluators);

  return (
    <SuiteSettingsRow
      settingKey="scripts"
      chained={false}
      data-subsection-id="scripts"
      hint={SETUP_CLEANUP_HINT}
      accessory={accessory}
      {...(note ? { "data-read-only-reason": note } : {})}
    >
      <div className="space-y-4">
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
        {SCRIPT_SLOTS.map((slot) => {
          const text = scripts?.[slot.key];
          const open = text !== undefined || touched.has(slot.key);
          if (!open && !gate.canEdit) return null;
          return (
            <ScriptSlotEditor
              key={slot.key}
              slot={slot}
              text={text}
              open={open}
              editable={gate.canEdit}
              onOpen={() => setTouchedSlot(slot.key, true)}
              onChange={(next) => edit(slot.key, next, true)}
              onRemove={() => edit(slot.key, undefined, false)}
            />
          );
        })}
        <FieldError className="text-xs">{totalHint}</FieldError>
        {runRefusal && hasScripts(saved) ? (
          <CloudUnreachableNotice
            data-testid="suite-scripts-cloud-unreachable"
            message={runRefusal}
            detail={
              HOSTED_MODE
                ? "Run all stays off until cloud sandboxes are reachable."
                : "Open the suite on MCPJam to run it. Run all is off here because this inspector can't start these scripts."
            }
            {...(HOSTED_MODE
              ? {}
              : {
                  action: {
                    label: "Open on MCPJam",
                    href: suiteOnMcpjamUrl(suite._id),
                  },
                })}
          />
        ) : null}
      </div>
    </SuiteSettingsRow>
  );
}

function ScriptSlotEditor({
  slot,
  text,
  open,
  editable,
  onOpen,
  onChange,
  onRemove,
}: {
  slot: (typeof SCRIPT_SLOTS)[number];
  text: string | undefined;
  open: boolean;
  editable: boolean;
  onOpen: () => void;
  onChange: (text: string | undefined) => void;
  onRemove: () => void;
}) {
  const fieldId = useId();
  // Add script opens the field; it takes focus as it mounts.
  const [focusWhenOpened, setFocusWhenOpened] = useState(false);
  const sizeHint = scriptSizeHint(text);
  return (
    <div className="space-y-2" data-script-slot={slot.key}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{slot.title}</p>
          <p className="text-xs text-muted-foreground">{slot.note}</p>
        </div>
        {open ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={`Remove the ${slot.title} script`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={`Add script: ${slot.title}`}
            onClick={() => {
              setFocusWhenOpened(true);
              onOpen();
            }}
          >
            <Plus aria-hidden="true" />
            Add script
          </Button>
        ) : null}
      </div>
      {open ? (
        <>
          <Textarea
            id={fieldId}
            autoFocus={focusWhenOpened}
            value={text ?? ""}
            readOnly={!editable}
            spellCheck={false}
            aria-label={`${slot.title} script`}
            aria-invalid={sizeHint ? true : undefined}
            aria-describedby={sizeHint ? `${fieldId}-hint` : undefined}
            onChange={(event) => onChange(event.target.value || undefined)}
            className={cn(SCRIPT_TEXT_CLASS, "min-h-20 resize-y")}
          />
          <FieldError id={`${fieldId}-hint`} className="text-xs">
            {sizeHint}
          </FieldError>
        </>
      ) : null}
    </div>
  );
}
