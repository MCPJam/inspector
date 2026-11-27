import { CheckCircle2, CircleSlash } from "lucide-react";
import { Switch } from "@mcpjam/design-system/switch";
import {
  EVENT_DELIVERY_MODES,
  setEventsHostSetting,
  type EventDeliveryMode,
} from "@mcpjam/sdk/browser";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  describeClientEvents,
  type ClientEventsView,
} from "@/shared/client-events";
import { FocusBlock } from "./primitives";

/** The spec's name for each delivery mode, and the method that starts it. */
const MODES: Record<EventDeliveryMode, { label: string; method: string }> = {
  poll: { label: "Poll", method: "events/poll" },
  push: { label: "Push", method: "events/stream" },
  webhook: { label: "Webhook", method: "events/subscribe" },
};

function listModes(modes: readonly EventDeliveryMode[], joiner: string) {
  const labels = modes.map((mode) => MODES[mode].label);
  if (labels.length < 2) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} ${joiner} ${labels.at(-1)}`;
}

function receivesLine(view: ClientEventsView): string {
  if (view.harness) return "Receives no events.";
  if (view.setting === "invalid")
    return "Receives no events, because its saved setting can't be read. Turn on the modes it should receive to repair it.";
  if (view.modes.length === 0)
    return "Receives no events. Turn on a delivery mode below.";
  return `Receives events by ${listModes(view.modes, "and")}.`;
}

function agentLine(view: ClientEventsView): string {
  const tools = view.agentTools;
  if (tools.available)
    return `The agent can subscribe from chat, by ${listModes(tools.modes, "or")}.`;
  switch (tools.reason) {
    case "harness":
      return "The agent can't subscribe from chat in this client. Pick another client in the Playground.";
    case "invalid":
    case "no-modes":
      return "The agent can't subscribe from chat until this client receives events.";
    case "runtime":
      return "The agent can't subscribe from chat here, because hosted MCPJam can't deliver push yet. Turn on Poll or Webhook, or use MCPJam locally.";
    case "local-webhook":
      return "The agent can't subscribe from chat by Webhook here, because a local webhook needs your consent each time. Turn on Poll or Push, or connect the event from the Playground's Events pane.";
  }
}

/** A runtime limit on one mode, shown under its row. */
function limitLine(
  mode: EventDeliveryMode,
  view: ClientEventsView,
): string | null {
  if (view.harness) return null;
  if (mode === "push" && view.runtime === "hosted")
    return "Hosted MCPJam can't deliver push yet. Push subscriptions need MCPJam running locally.";
  if (mode === "webhook" && view.runtime === "local")
    return "The agent doesn't subscribe by webhook here, because a local webhook needs your consent each time. Connect one from the Playground's Events pane.";
  return null;
}

function StatusLine({ ok, children }: { ok: boolean; children: string }) {
  const Icon = ok ? CheckCircle2 : CircleSlash;
  return (
    <p className="flex items-start gap-2 text-[12px] leading-snug">
      <Icon
        aria-hidden
        className={
          ok
            ? "mt-px size-3.5 shrink-0 text-foreground"
            : "mt-px size-3.5 shrink-0 text-muted-foreground"
        }
      />
      <span>{children}</span>
    </p>
  );
}

/**
 * The client's MCP Events delivery modes (`com.mcpjam/events`, MCPJam policy:
 * no server sees it), named as the spec names them. Subscriptions made as
 * this client, and the agent's subscriptions from chat, use only these.
 * Under a vendor harness the vendor's own client decides, and none of them
 * receives MCP Events, so nothing is editable.
 */
export function ClientEventsTab({
  draft,
  onDraftChange,
  readOnly = false,
  hosted,
}: {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  readOnly?: boolean;
  hosted: boolean;
}) {
  const view = describeClientEvents(draft, {
    runtime: hosted ? "hosted" : "local",
    readOnly,
  });

  const toggle = (mode: EventDeliveryMode, on: boolean) => {
    onDraftChange((prev) => {
      const current = describeClientEvents(prev, {
        runtime: hosted ? "hosted" : "local",
      }).modes;
      const next = on
        ? [...current, mode]
        : current.filter((value) => value !== mode);
      return setEventsHostSetting(prev, next);
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="client-events-tab">
      <FocusBlock
        title="Event delivery"
        subtitle="The MCP Events delivery modes this client receives. Subscriptions made as this client can use only these modes."
      >
        <div
          className="flex flex-col gap-1.5 rounded-md border border-border/50 px-3 py-2"
          data-testid="client-events-status"
        >
          <StatusLine ok={view.modes.length > 0}>
            {receivesLine(view)}
          </StatusLine>
          <StatusLine ok={view.agentTools.available}>
            {agentLine(view)}
          </StatusLine>
        </div>
        {view.harness ? (
          <p
            className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground"
            data-testid="client-events-harness"
          >
            {view.harness.name} runs this client&apos;s agent loop, and it
            doesn&apos;t receive MCP Events, so this client receives none. Its
            delivery modes can&apos;t be changed here.
          </p>
        ) : null}
        <div className="flex flex-col divide-y divide-border/50 rounded-md border border-border/50">
          {EVENT_DELIVERY_MODES.map((mode) => {
            const { label, method } = MODES[mode];
            const limit = limitLine(mode, view);
            return (
              <div key={mode} className="px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px]">
                    {label}
                    <code className="ml-1.5 text-[10px] text-muted-foreground">
                      {method}
                    </code>
                  </span>
                  <Switch
                    checked={view.modes.includes(mode)}
                    onCheckedChange={(checked) => toggle(mode, checked)}
                    disabled={!view.editable}
                    aria-label={`${label} (${method})`}
                  />
                </div>
                {limit ? (
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {limit}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </FocusBlock>
    </div>
  );
}
