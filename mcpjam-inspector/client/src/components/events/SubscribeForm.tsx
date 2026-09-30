import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { cn } from "@mcpjam/design-system/cn";
import { AlertTriangle, BellPlus, Loader2 } from "lucide-react";
import {
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { getEventsProfile, usableDeliveryModes } from "@/lib/events-profiles";
import type {
  EventDescriptorView,
  EventsDeliveryModeView,
  EventsProfileIdView,
} from "@/shared/events-api";

export interface SubscribeFormValue {
  arguments: Record<string, unknown>;
  mode: EventsDeliveryModeView;
  maxAgeMs?: number;
  /** `null` asks for no expiry; absent leaves it to the server. */
  ttlMs?: number | null;
  /** Local webhook only: the user acknowledged the development receiver. */
  insecureLocalReceiver?: boolean;
}

const MODE_LABELS: Record<EventsDeliveryModeView, string> = {
  poll: "Poll",
  push: "Push",
  webhook: "Webhook",
};

const MODE_HINTS: Record<EventsDeliveryModeView, string> = {
  poll: "MCPJam calls events/poll on the server's suggested interval.",
  push: "MCPJam holds an events/stream open and the server pushes events.",
  webhook: "The server POSTs each event to a callback URL MCPJam registers.",
};

function parseOptionalMs(
  raw: string,
  label: string,
): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return { error: `${label} must be a whole number of milliseconds.` };
  }
  return { value };
}

/**
 * Subscribe to one event type. Arguments come from the event's
 * `inputSchema` as a generated form (raw JSON when the schema has no
 * describable properties); the delivery mode is limited to what both the
 * event advertises and the selected profile's host uses.
 */
export function SubscribeForm({
  event,
  profileId,
  hosted,
  busy,
  onSubscribe,
}: {
  event: EventDescriptorView;
  profileId: EventsProfileIdView;
  hosted: boolean;
  busy: boolean;
  onSubscribe: (value: SubscribeFormValue) => void | Promise<void>;
}) {
  const [fields, setFields] = useState<FormField[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState("{}");
  const [mode, setMode] = useState<EventsDeliveryModeView | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [maxAgeMs, setMaxAgeMs] = useState("");
  const [ttlMs, setTtlMs] = useState("");
  const [noExpiry, setNoExpiry] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const next = generateFormFieldsFromSchema(event.inputSchema);
    setFields(next);
    setRawMode(next.length === 0);
    setRawJson("{}");
    setAcknowledged(false);
    setMaxAgeMs("");
    setTtlMs("");
    setNoExpiry(false);
    setFormError(null);
    // Keyed on the event's identity alone, so a catalog refresh does not wipe
    // what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.name]);

  const modes = useMemo(
    () => usableDeliveryModes(event.delivery, profileId),
    [event.delivery, profileId],
  );

  useEffect(() => {
    if (mode === null || !modes.includes(mode)) setMode(modes[0] ?? null);
  }, [modes, mode]);

  const profile = getEventsProfile(profileId);
  const needsAcknowledgement = !hosted && mode === "webhook";
  const canSubmit =
    mode !== null && !busy && (!needsAcknowledgement || acknowledged);

  const onFieldChange = (name: string, value: unknown) => {
    setFields((previous) =>
      previous.map((field) =>
        field.name === name ? { ...field, value, isSet: true } : field,
      ),
    );
  };
  const onToggleField = (name: string, isSet: boolean) => {
    setFields((previous) =>
      previous.map((field) =>
        field.name === name ? { ...field, isSet } : field,
      ),
    );
  };

  const submit = () => {
    if (!canSubmit || mode === null) return;
    let args: Record<string, unknown>;
    if (rawMode) {
      try {
        const parsed = JSON.parse(rawJson || "{}");
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setFormError("Arguments must be a JSON object.");
          return;
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        setFormError(error instanceof Error ? error.message : "Invalid JSON.");
        return;
      }
    } else {
      args = buildParametersFromFields(fields);
    }
    const maxAge = parseOptionalMs(maxAgeMs, "maxAgeMs");
    if (maxAge.error) {
      setFormError(maxAge.error);
      return;
    }
    const ttl = noExpiry ? { value: null } : parseOptionalMs(ttlMs, "ttlMs");
    if ("error" in ttl && ttl.error) {
      setFormError(ttl.error);
      return;
    }
    setFormError(null);
    void onSubscribe({
      arguments: args,
      mode,
      ...(maxAge.value !== undefined ? { maxAgeMs: maxAge.value } : {}),
      ...(ttl.value !== undefined ? { ttlMs: ttl.value } : {}),
      ...(needsAcknowledgement ? { insecureLocalReceiver: true } : {}),
    });
  };

  const idPrefix = `subscribe-${event.name}`;

  return (
    <div className="space-y-4" data-testid="subscribe-form">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-foreground">Arguments</h4>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setRawMode((value) => !value)}
          >
            {rawMode ? "Use form" : "Use JSON"}
          </Button>
        </div>
        {rawMode ? (
          <Textarea
            aria-label="Arguments JSON"
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            spellCheck={false}
            rows={5}
            className="font-mono text-xs"
          />
        ) : (
          <div className="rounded-md border border-border">
            <ParametersForm
              fields={fields}
              onFieldChange={onFieldChange}
              onToggleField={onToggleField}
            />
          </div>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-foreground">
          Delivery mode
        </legend>
        {modes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This event advertises no delivery mode the {profile.label} profile
            uses. It advertises {event.delivery.join(", ") || "none"}; the
            profile uses {profile.deliveryModes.join(", ")}.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {modes.map((option) => (
              <label
                key={option}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
                  mode === option
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
                title={MODE_HINTS[option]}
              >
                <input
                  type="radio"
                  name={`${idPrefix}-mode`}
                  value={option}
                  checked={mode === option}
                  onChange={() => setMode(option)}
                  className="accent-primary"
                />
                {MODE_LABELS[option]}
              </label>
            ))}
          </div>
        )}
        {mode ? (
          <p className="text-[11px] text-muted-foreground">
            {MODE_HINTS[mode]}
          </p>
        ) : null}
        {mode === "webhook" && hosted ? (
          <p className="text-[11px] text-muted-foreground">
            Deliveries go to MCPJam's public inbox, which verifies each
            signature before anything is journalled.
          </p>
        ) : null}
        {needsAcknowledgement ? (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-start gap-2 text-xs text-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
              <p>
                Locally, webhooks go to the inspector's development receiver:
                plain http on this machine. The server must be able to reach it,
                and a run that uses it is labelled as a development override and
                never counts as a conformance pass.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-ack`}
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <Label htmlFor={`${idPrefix}-ack`} className="text-xs">
                Use local development receiver (non-conformant, plain http)
              </Label>
            </div>
          </div>
        ) : null}
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-max-age`} className="text-xs">
            maxAgeMs (optional)
          </Label>
          <Input
            id={`${idPrefix}-max-age`}
            type="number"
            min={0}
            value={maxAgeMs}
            onChange={(e) => setMaxAgeMs(e.target.value)}
            placeholder="Server default"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-ttl`} className="text-xs">
            ttlMs (optional)
          </Label>
          <Input
            id={`${idPrefix}-ttl`}
            type="number"
            min={0}
            value={noExpiry ? "" : ttlMs}
            disabled={noExpiry}
            onChange={(e) => setTtlMs(e.target.value)}
            placeholder={noExpiry ? "No expiry" : "Server default"}
            className="h-8 text-xs"
          />
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id={`${idPrefix}-no-expiry`}
              checked={noExpiry}
              onCheckedChange={(checked) => setNoExpiry(checked === true)}
            />
            <Label
              htmlFor={`${idPrefix}-no-expiry`}
              className="text-[11px] text-muted-foreground"
            >
              No expiry (ttlMs: null)
            </Label>
          </div>
        </div>
      </div>

      {formError ? (
        <p role="alert" className="text-xs text-destructive">
          {formError}
        </p>
      ) : null}

      <Button type="button" size="sm" onClick={submit} disabled={!canSubmit}>
        {busy ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <BellPlus className="mr-1.5 h-3.5 w-3.5" />
        )}
        Subscribe
      </Button>
    </div>
  );
}
