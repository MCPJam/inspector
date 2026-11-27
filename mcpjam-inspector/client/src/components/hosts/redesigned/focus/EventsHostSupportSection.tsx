import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  EVENT_DELIVERY_MODES,
  readEventsHostSetting,
  resolveHostEventDeliveryModes,
  setEventsHostSetting,
  type EventDeliveryMode,
} from "@mcpjam/sdk/browser";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { hostConfigField } from "@/lib/host-config-field-schema";

const MODE_LABELS: Record<EventDeliveryMode, string> = {
  webhook: "Webhook",
  poll: "Poll",
  push: "Push",
};

/**
 * Which MCP Events delivery modes this client receives
 * (`mcpProfile.extensions["com.mcpjam/events"]`). MCPJam policy: no server
 * sees it. Subscriptions made as this client, and the trigger runs that act
 * as it, may use only these modes; the backend refuses the rest.
 *
 * Nothing saved means no events: the boxes show what the client receives,
 * and every change saves the modes explicitly.
 */
export function EventsHostSupportSection({
  draft,
  onDraftChange,
  readOnly,
}: {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  readOnly: boolean;
}) {
  const field = hostConfigField("eventsDeliveryModes");
  const setting = readEventsHostSetting(draft);
  const effective = resolveHostEventDeliveryModes(draft);

  const toggle = (mode: EventDeliveryMode, on: boolean) => {
    onDraftChange((prev) => {
      const current = resolveHostEventDeliveryModes(prev);
      const next = on
        ? [...current, mode]
        : current.filter((value) => value !== mode);
      return setEventsHostSetting(prev, next);
    });
  };

  return (
    <div
      className="mt-2.5 border-t border-border/50 pt-2.5"
      data-testid="events-host-support"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] font-medium">{field.label}</span>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Choose the MCP Events delivery modes this client receives.
            Subscriptions made as this client can use only these modes.
          </p>
          {setting.kind === "invalid" ? (
            <p className="text-[11px] leading-snug text-destructive">
              This client&apos;s saved event delivery setting can&apos;t be
              read, so it receives no events. Pick the modes again to repair it.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 pl-1">
        {EVENT_DELIVERY_MODES.map((mode) => {
          const id = `events-delivery-${mode}`;
          return (
            <div key={mode} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={effective.includes(mode)}
                onCheckedChange={(checked) => toggle(mode, checked === true)}
                disabled={readOnly}
              />
              <label htmlFor={id} className="text-[11px] text-foreground">
                {MODE_LABELS[mode]}
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
