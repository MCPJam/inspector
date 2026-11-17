import { useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";
import { useSoftQuery } from "@/hooks/use-soft-query";
import {
  HARNESS_DESCRIPTORS,
  MCPJAM_HARNESS_NAME,
} from "@/shared/harness-descriptors";
import { NATIVE_HARNESS_TRIAL_EXHAUSTED_CODE } from "@/shared/native-harness-trial";
import { useNativeHarnessLimitDialogStore } from "@/stores/native-harness-limit-dialog-store";

type HarnessPick = "mcpjam" | "native";
type EditBlockedReason = "not_project_admin" | "client_locked_by_study";

/** The tooltip on a section the user can't change, by the backend's reason. */
const EDIT_BLOCKED_COPY: Record<EditBlockedReason, string> = {
  not_project_admin: "Only project admins can change this client.",
  client_locked_by_study:
    "A study another member made uses this client. Changing it requires Team or Enterprise.",
};

/** `clientHarness:getClientHarnessChoice`; null for a client with no choice. */
export interface ClientHarnessChoice {
  current: HarnessPick;
  native: keyof typeof HARNESS_DESCRIPTORS;
  /** False exactly when `unavailableReason` is set. */
  nativeAvailable: boolean;
  unavailableReason:
    | null
    | "runtime_unavailable"
    | "cursor_key_missing"
    | "model_unsupported"
    | "trial_exhausted";
  /** A project admin, and no study another member made holds the client. */
  canEdit: boolean;
  /** Why `canEdit` is false. Older backends leave it out. */
  editBlockedReason?: EditBlockedReason | null;
  trial: { applies: boolean; granted: number; used: number; remaining: number };
}

const setClientHarnessRef = makeFunctionReference<
  "mutation",
  { hostId: string; choice: HarnessPick },
  ClientHarnessChoice
>("clientHarness:setClientHarness");

function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  return data && typeof data === "object" && "code" in data
    ? String(data.code)
    : undefined;
}

/** Why the native runtime can't run, and the one thing that fixes it. */
export function harnessUnavailableReason(
  choice: ClientHarnessChoice,
  modelLabel: string | null,
): string | null {
  const name = HARNESS_DESCRIPTORS[choice.native].runtimeName;
  switch (choice.unavailableReason) {
    case "runtime_unavailable":
      return `${name} isn't available for your account.`;
    case "cursor_key_missing":
      return `${name} needs a Cursor key. Add one in AI providers.`;
    case "model_unsupported":
      return `${name} can't run ${modelLabel ?? "this model"}. Choose another model in the Agent tab.`;
    case "trial_exhausted":
      return `Your organization has used its ${choice.trial.granted} free native harness turns.`;
    default:
      return null;
  }
}

export interface HostHarnessChoiceProps {
  hostId: string;
  /** The client draft has unsaved edits, which a harness save would discard. */
  isDirty: boolean;
  /** Read-only canvases (Project Environments) name the harness and stop there. */
  readOnly: boolean;
  modelLabel: string | null;
}

/**
 * The Harness section of the client card: MCPJam Harness or the client's
 * native runtime. A click saves at once, for the client's next new chats,
 * rather than joining the "Save client" draft: a later save of that draft
 * would otherwise put back a harness the limit dialog switched away from.
 * The backend decides who sees it: a null choice (no native runtime, a
 * feature the user lacks, a client they can't read) shows no section.
 */
export function HostHarnessChoice({
  hostId,
  isDirty,
  readOnly,
  modelLabel,
}: HostHarnessChoiceProps) {
  const { data: choice } = useSoftQuery<ClientHarnessChoice | null>(
    "clientHarness:getClientHarnessChoice",
    { hostId },
  );
  const setClientHarness = useMutation(setClientHarnessRef);
  const [saving, setSaving] = useState(false);
  if (!choice) return null;

  const nativeName = HARNESS_DESCRIPTORS[choice.native].runtimeName;
  const nameOf = (pick: HarnessPick) =>
    pick === "native" ? nativeName : MCPJAM_HARNESS_NAME;
  if (readOnly) {
    return (
      <HarnessSection>
        <div className="hp-caps">
          <span className="hp-cap hp-cap--selected">
            <span className="hp-cap-dot" aria-hidden />
            <span className="hp-cap-name">{nameOf(choice.current)}</span>
          </span>
        </div>
      </HarnessSection>
    );
  }

  const blockedBy = !choice.canEdit
    ? EDIT_BLOCKED_COPY[choice.editBlockedReason ?? "not_project_admin"]
    : isDirty
      ? "Save or discard your changes first."
      : null;
  const reason = harnessUnavailableReason(choice, modelLabel);
  const choose = async (pick: HarnessPick) => {
    if (pick === choice.current || saving) return;
    if (pick === "native" && choice.unavailableReason === "trial_exhausted") {
      useNativeHarnessLimitDialogStore
        .getState()
        .open({ granted: choice.trial.granted });
      return;
    }
    setSaving(true);
    try {
      await setClientHarness({ hostId, choice: pick });
      toast.success(`New chats use ${nameOf(pick)}.`);
    } catch (error) {
      if (refusalCode(error) === NATIVE_HARNESS_TRIAL_EXHAUSTED_CODE) {
        useNativeHarnessLimitDialogStore
          .getState()
          .open({ granted: choice.trial.granted });
      } else {
        toast.error(
          convexErrMessage(error, "Could not change this client's harness. Try again."),
        );
      }
    } finally {
      setSaving(false);
    }
  };
  const chip = (pick: HarnessPick) => {
    const selected = choice.current === pick;
    const off = pick === "native" && !choice.nativeAvailable;
    const tag =
      pick === "native" && choice.trial.applies && !off
        ? `${choice.trial.remaining} / ${choice.trial.granted} turns left`
        : null;
    return (
      <button
        key={pick}
        type="button"
        aria-pressed={selected}
        aria-busy={saving || undefined}
        disabled={
          blockedBy !== null ||
          (off && choice.unavailableReason !== "trial_exhausted")
        }
        className={cn(
          "hp-cap disabled:cursor-not-allowed disabled:opacity-60",
          off && "hp-cap--off",
          selected && "hp-cap--selected",
        )}
        onClick={(event) => {
          event.stopPropagation();
          void choose(pick);
        }}
      >
        {selected || off ? <span className="hp-cap-dot" aria-hidden /> : null}
        <span className="hp-cap-name">{nameOf(pick)}</span>
        {tag ? <span className="hp-cap-tag">{tag}</span> : null}
      </button>
    );
  };
  const chips = (
    <div className="hp-caps" role="group" aria-label="Harness">
      {chip("mcpjam")}
      {chip("native")}
    </div>
  );

  return (
    <HarnessSection>
      {blockedBy ? (
        // A disabled button takes no pointer events, so the tooltip hangs off
        // a wrapper, as the disabled "Save client" button's does.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{chips}</span>
          </TooltipTrigger>
          <TooltipContent side="top" variant="muted">
            {blockedBy}
          </TooltipContent>
        </Tooltip>
      ) : (
        chips
      )}
      {reason ? (
        <p className="text-xs leading-snug text-muted-foreground">{reason}</p>
      ) : null}
    </HarnessSection>
  );
}

function HarnessSection({ children }: { children: ReactNode }) {
  return (
    <div className="hp-section" data-testid="host-harness-choice">
      <span className="hp-section-title">Harness</span>
      {children}
    </div>
  );
}
