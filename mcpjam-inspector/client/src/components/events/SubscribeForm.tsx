import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { cn } from "@mcpjam/design-system/cn";
import {
  describeModeRefusal,
  isEventDeliveryMode,
  type SubscribableModes,
} from "@mcpjam/sdk/browser";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import type { EventsDeliveryModeView } from "@/shared/events-api";
import { CallbackField } from "./CallbackField";
import type { SubscribeForm } from "./use-subscribe-form";

export type { SubscribeFormValue } from "./use-subscribe-form";

const MODE_LABELS: Record<EventsDeliveryModeView, string> = {
  poll: "Poll",
  push: "Push",
  webhook: "Webhook",
};

const MODE_HINTS: Record<EventsDeliveryModeView, string> = {
  poll: "MCPJam checks for new events at the server's suggested interval.",
  push: "MCPJam keeps an events/stream request open and the server pushes events on it.",
  webhook: "The server sends each event to a callback URL MCPJam registers.",
};

/** The request fields MCPJam fills in itself, by mode. */
const MANAGED_FIELDS: Record<EventsDeliveryModeView, string[]> = {
  poll: ["cursor", "maxEvents"],
  push: ["cursor", "heartbeatMs"],
  webhook: ["cursor", "delivery.url", "delivery.secret"],
};

/** Subscription arguments: the generated form, or raw JSON. */
export function SubscribeParameters({ form }: { form: SubscribeForm }) {
  return (
    <div className="space-y-2" data-testid="subscribe-parameters">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={form.toggleRawMode}
        >
          {form.rawMode ? "Use form" : "Use JSON"}
        </Button>
      </div>
      {form.rawMode ? (
        <Textarea
          aria-label="Arguments JSON"
          value={form.rawJson}
          onChange={(e) => form.setRawJson(e.target.value)}
          spellCheck={false}
          rows={5}
          className="font-mono text-xs"
        />
      ) : (
        <ParametersForm
          fields={form.fields}
          onFieldChange={form.onFieldChange}
          onToggleField={form.onToggleField}
          onExecute={form.submit}
        />
      )}
    </div>
  );
}

/**
 * Every delivery mode the event type advertises. Modes the client, the event
 * type or this runtime refuse stay listed, disabled, with the reason; a mode
 * outside the spec's three is shown but can never be picked.
 */
export function SubscribeDelivery({
  form,
  eventName,
  delivery,
  availability,
  hostName,
  hosted,
  replayUnsupported,
  localCallbackBase,
}: {
  form: SubscribeForm;
  eventName: string;
  delivery: string[];
  availability: SubscribableModes | undefined;
  hostName: string;
  hosted: boolean;
  localCallbackBase?: string;
  /** A subscription to this event type got `cursor: null` back. */
  replayUnsupported: boolean;
}) {
  const usable = availability?.modes ?? [];
  return (
    <fieldset className="space-y-2" data-testid="subscribe-delivery">
      <legend className="sr-only">Delivery mode</legend>
      <div className="space-y-1.5">
        {delivery.map((option) => {
          const known = isEventDeliveryMode(option);
          const enabled = known && usable.includes(option);
          const reason = !known
            ? "Not a delivery mode the spec defines (poll, push, webhook)."
            : availability
              ? describeModeRefusal(option, availability, hostName)
              : null;
          return (
            <div key={option} className="space-y-0.5">
              <label
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
                  !enabled
                    ? "cursor-not-allowed border-border text-muted-foreground"
                    : form.mode === option
                      ? "cursor-pointer border-primary bg-primary/10 text-foreground"
                      : "cursor-pointer border-border text-muted-foreground hover:bg-accent",
                )}
              >
                <input
                  type="radio"
                  name={`subscribe-${eventName}-mode`}
                  value={option}
                  checked={enabled && form.mode === option}
                  disabled={!enabled}
                  onChange={() => {
                    if (known) form.setMode(option);
                  }}
                  className="accent-primary"
                />
                {known ? MODE_LABELS[option] : option}
              </label>
              {!enabled && reason ? (
                <p className="pl-3 text-[11px] text-muted-foreground">
                  {reason}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {form.mode ? (
        <p className="text-[11px] text-muted-foreground">
          {MODE_HINTS[form.mode]}
        </p>
      ) : null}
      {form.mode === "webhook" && hosted ? (
        <p className="text-[11px] text-muted-foreground">
          Deliveries go to MCPJam's public inbox, which checks each signature.
        </p>
      ) : null}
      {replayUnsupported ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="replay-unsupported"
        >
          This event type can't replay events missed while a subscription is
          down.
        </p>
      ) : null}
      {form.mode === "webhook" && !hosted ? (
        <CallbackField form={form} localCallbackBase={localCallbackBase} />
      ) : null}
    </fieldset>
  );
}

/**
 * The request fields a user may set, under their spec names, for the chosen
 * mode only. The ones MCPJam fills in itself are named, not editable.
 */
export function SubscribeAdvanced({
  form,
  eventName,
  hosted,
}: {
  form: SubscribeForm;
  eventName: string;
  hosted: boolean;
}) {
  const idPrefix = `subscribe-${eventName}`;
  return (
    <div className="space-y-3" data-testid="subscribe-advanced">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-max-age`} className="font-mono text-xs">
          maxAgeMs
        </Label>
        <Input
          id={`${idPrefix}-max-age`}
          type="number"
          min={0}
          value={form.maxAgeMs}
          onChange={(e) => form.setMaxAgeMs(e.target.value)}
          placeholder="Server default"
          className="h-8 text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Don't replay events older than this many milliseconds.
        </p>
      </div>
      {form.mode === "webhook" ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-ttl`} className="font-mono text-xs">
            ttlMs
          </Label>
          <Input
            id={`${idPrefix}-ttl`}
            type="number"
            min={0}
            value={form.noExpiry ? "" : form.ttlMs}
            disabled={form.noExpiry}
            onChange={(e) => form.setTtlMs(e.target.value)}
            placeholder={form.noExpiry ? "No expiry" : hosted ? "Server default" : "10 minutes"}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            Suggested lifetime. The server decides when the subscription
            expires, and MCPJam refreshes it before then.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id={`${idPrefix}-no-expiry`}
              checked={form.noExpiry}
              onCheckedChange={(checked) => form.setNoExpiry(checked === true)}
            />
            <Label
              htmlFor={`${idPrefix}-no-expiry`}
              className="text-[11px] text-muted-foreground"
            >
              No expiry
            </Label>
          </div>
          {!hosted && form.noExpiry ? (
            <p className="text-[11px] text-warning">
              The server can keep sending events after MCPJam closes.
            </p>
          ) : null}
        </div>
      ) : null}
      {form.mode ? (
        <p className="text-[11px] text-muted-foreground">
          MCPJam sets{" "}
          {MANAGED_FIELDS[form.mode].map((field, index, all) => (
            <span key={field}>
              <code className="font-mono">{field}</code>
              {index < all.length - 2
                ? ", "
                : index === all.length - 2
                  ? " and "
                  : ""}
            </span>
          ))}{" "}
          for you.
        </p>
      ) : null}
    </div>
  );
}
