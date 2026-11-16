import { useEffect, useState, type FormEvent } from "react";
import type { ModelRates } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { FieldError } from "@mcpjam/design-system/field-error";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  MODEL_RATE_FIELDS,
  MODEL_RATE_LABELS,
  normalizeModelRateInput,
  type ModelRateField,
  type ModelRateInputResult,
} from "@/shared/model-rate-input";
import {
  dayInputToTime,
  timeToDayInput,
  type ModelRateRow,
} from "./model-rate-format";

export type SavedModelRate = Extract<
  ModelRateInputResult,
  { ok: true }
>["value"];

type Draft = Record<
  "modelId" | "providerKey" | "effectiveDay" | "note" | ModelRateField,
  string
>;

const ANY_PROVIDER = "__any";
const RATE_KEYS = new Set<string>(MODEL_RATE_FIELDS);

/** The text inputs, in order: id, label, placeholder. */
const TEXT_FIELDS: ReadonlyArray<[keyof Draft, string, string]> = [
  ["modelId", "Model ID", "anthropic/claude-sonnet-4.5"],
  ...MODEL_RATE_FIELDS.map((field): [keyof Draft, string, string] => [
    field,
    MODEL_RATE_LABELS[field],
    field.startsWith("cache") ? "Not set" : "0.00",
  ]),
  ["effectiveDay", "Effective date", ""],
  ["note", "Note", "Optional"],
];

/** A scheduled rate keeps its date; anything else starts the new revision now. */
const scheduledDay = (editing: ModelRateRow | undefined) =>
  editing && editing.effectiveAt > Date.now()
    ? timeToDayInput(editing.effectiveAt)
    : "";

function draftFrom(editing: ModelRateRow | undefined): Draft {
  const rate = (field: ModelRateField) =>
    editing?.rates[field]?.toString() ?? "";
  return {
    modelId: editing?.modelId ?? "",
    providerKey: editing?.providerKey ?? "",
    input: rate("input"),
    output: rate("output"),
    cacheRead: rate("cacheRead"),
    cacheWrite: rate("cacheWrite"),
    effectiveDay: scheduledDay(editing),
    note: "",
  };
}

/** Blank is "not set"; anything else that is not a number is refused. */
const readNumber = (value: string) =>
  value.trim() === "" ? undefined : Number(value);

/**
 * Add a price, or save a new revision of one. Saving never changes a call
 * already priced: the old revision stays on the calls that used it.
 */
export function ModelRateDialog({
  open,
  onOpenChange,
  editing,
  providers,
  requireProvider,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ModelRateRow;
  providers: ReadonlyArray<{ key: string; name: string }>;
  /** A local override prices one provider; an org rate may apply to any. */
  requireProvider: boolean;
  /** Rejects with the message to show when the save fails. */
  onSave: (rate: SavedModelRate) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(editing));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(editing));
    setError(undefined);
  }, [open, editing]);

  // This form cannot edit context tiers, so it says they are kept.
  const tierFloor = editing?.rates.tiers?.length
    ? Math.min(...editing.rates.tiers.map((tier) => tier.aboveInputTokens))
    : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // An unchanged date keeps the scheduled time exactly, which another
    // admin may have set in another time zone.
    const keepsSchedule =
      draft.effectiveDay !== "" && draft.effectiveDay === scheduledDay(editing);
    const result = normalizeModelRateInput(
      {
        modelId: draft.modelId,
        providerKey: draft.providerKey,
        rates: Object.fromEntries(
          MODEL_RATE_FIELDS.map((field) => [field, readNumber(draft[field])]),
        ),
        effectiveAt: keepsSchedule
          ? editing?.effectiveAt
          : dayInputToTime(draft.effectiveDay),
        note: draft.note,
      },
      { now: Date.now(), requireProvider },
    );
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Rates this form does not edit (one-hour cache writes, web search,
    // context tiers) carry over to the new revision unchanged.
    const prior: Partial<ModelRates> = editing?.rates ?? {};
    const { tiers, cacheWrite1h, webSearchPerThousand } = prior;
    const kept = Object.fromEntries(
      Object.entries({ tiers, cacheWrite1h, webSearchPerThousand }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    setSaving(true);
    try {
      await onSave({
        ...result.value,
        rates: { ...kept, ...result.value.rates },
      });
      onOpenChange(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit model price" : "Add model price"}
            </DialogTitle>
            <DialogDescription>
              Prices are in US dollars per million tokens. Saving adds a new
              revision; calls already priced keep the price they used.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rate-providerKey">Provider</Label>
              <Select
                value={draft.providerKey || ANY_PROVIDER}
                disabled={!!editing}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    providerKey: value === ANY_PROVIDER ? "" : value,
                  })
                }
              >
                <SelectTrigger id="rate-providerKey" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_PROVIDER}>
                    {requireProvider ? "Pick a provider" : "Any provider"}
                  </SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider.key} value={provider.key}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {TEXT_FIELDS.map(([key, label, placeholder]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`rate-${key}`}>{label}</Label>
                <Input
                  id={`rate-${key}`}
                  type={key === "effectiveDay" ? "date" : "text"}
                  inputMode={RATE_KEYS.has(key) ? "decimal" : undefined}
                  disabled={key === "modelId" && !!editing}
                  placeholder={placeholder}
                  value={draft[key]}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.value })
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Leave the effective date empty to start now. Without a cache price,
            cached tokens stay unpriced.
          </p>
          {tierFloor !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {`Saving keeps the long-context prices for calls above ${tierFloor.toLocaleString("en-US")} input tokens. To remove them, retire this price and add it again.`}
            </p>
          ) : null}
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save price"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
