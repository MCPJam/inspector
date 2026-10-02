/**
 * Who pays for a saved model: "MCPJam credits" or "Your key · <connection>".
 *
 * Read off the saved selection's `source`, never inferred from the model id:
 *
 *  - `hosted` → "MCPJam credits";
 *  - `org` → "Your key · <org provider>" (the org config's display name for
 *    the connection, else the resolved row's provider; "Your key" alone when
 *    neither resolves);
 *  - `local` → "Your key · <customProviderName ?? provider>";
 *  - a stored `legacy` selection → "Your key" (it means own key only);
 *  - no selection → nothing. Unlabelled rows keep today's behaviour and show
 *    no claim about who pays.
 *
 * A selection the backend set automatically (`selectionOrigin: "backfill"`)
 * adds a "Set automatically" hint with a button that opens the model picker,
 * so the user can confirm or switch.
 */
import type {
  ModelSelection,
  RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import { getProviderDisplayName } from "@/lib/provider-registry";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";

export type ModelSelectionOrigin = "backfill";

export type ModelSourceLabel = {
  kind: "hosted" | "own-key";
  /** "MCPJam credits", "Your key · OpenAI", "Your key". */
  text: string;
  /** The connection named after "Your key ·", when one resolved. */
  connection?: string;
};

const HOSTED_TEXT = "MCPJam credits";
const OWN_KEY_TEXT = "Your key";

function ownKey(connection: string | undefined): ModelSourceLabel {
  const name = connection?.trim();
  return name
    ? { kind: "own-key", text: `${OWN_KEY_TEXT} · ${name}`, connection: name }
    : { kind: "own-key", text: OWN_KEY_TEXT };
}

/**
 * The label for a saved selection, or `null` when there is none. `models`
 * (the picker rows) and `orgConfig` only help name an org connection.
 */
export function modelSourceLabel(
  selection: RequestedModelSelection | null | undefined,
  options: {
    models?: readonly ModelDefinition[];
    orgConfig?: OrgVisibleConfig;
  } = {},
): ModelSourceLabel | null {
  if (!selection) return null;
  switch (selection.source) {
    case "hosted":
      return { kind: "hosted", text: HOSTED_TEXT };
    case "legacy":
      return ownKey(undefined);
    case "local": {
      const ref = selection.connectionRef;
      if (ref?.kind !== "localProvider") return ownKey(undefined);
      return ownKey(
        ref.customProviderName ?? getProviderDisplayName(ref.providerKey),
      );
    }
    case "org":
      return ownKey(orgConnectionName(selection, options));
    default:
      return null;
  }
}

function orgConnectionName(
  selection: ModelSelection,
  {
    models,
    orgConfig,
  }: { models?: readonly ModelDefinition[]; orgConfig?: OrgVisibleConfig },
): string | undefined {
  const ref = selection.connectionRef;
  const id = ref?.kind === "orgProvider" ? ref.id : undefined;
  const provider = id
    ? orgConfig?.providers.find((candidate) => candidate.id === id)
    : undefined;
  if (provider) {
    return (
      provider.displayName?.trim() ||
      getProviderDisplayName(provider.providerKey)
    );
  }
  if (!models) return undefined;
  // Only a row actually served by an org connection names it; the id-only
  // fallback of the lookup may land on a hosted twin.
  const row = findModelForStoredChoice(
    { modelId: selection.modelId, selection },
    models,
    orgConfig,
  );
  return row?.orgProvider
    ? getProviderDisplayName(row.orgProvider.providerKey)
    : undefined;
}

export type ModelSourceBadgeProps = {
  /** The saved selection (a stored legacy one included). None ⇒ nothing. */
  selection: RequestedModelSelection | null | undefined;
  /** Picker rows, to name an org connection. */
  models?: readonly ModelDefinition[];
  orgConfig?: OrgVisibleConfig;
  /** `"backfill"`: the selection was set automatically, not by a person. */
  selectionOrigin?: ModelSelectionOrigin;
  /**
   * Opens the model picker so the user can confirm or switch. The "Set
   * automatically" hint shows its button only when this is passed.
   */
  onReview?: () => void;
  className?: string;
};

export function ModelSourceBadge({
  selection,
  models,
  orgConfig,
  selectionOrigin,
  onReview,
  className,
}: ModelSourceBadgeProps) {
  const label = modelSourceLabel(selection, { models, orgConfig });
  if (!label) return null;
  const backfilled = selectionOrigin === "backfill";
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      data-testid="model-source-badge"
      data-source={label.kind}
    >
      <Badge
        variant="outline"
        className="max-w-[200px] truncate border-border/60 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
        title={label.text}
      >
        {label.text}
      </Badge>
      {backfilled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
              data-testid="model-source-backfill-hint"
            >
              Set automatically
              {onReview ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-[10px]"
                  onClick={onReview}
                >
                  Review
                </Button>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] leading-snug">
            {label.kind === "hosted"
              ? "We set this model to run on MCPJam credits because it is in the hosted catalog. Open the picker to keep it or switch to your own key."
              : "We set this model to run on your own key because it is not in the hosted catalog. Open the picker to keep it or switch."}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
