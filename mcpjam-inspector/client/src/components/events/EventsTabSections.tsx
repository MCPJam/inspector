import { cn } from "@mcpjam/design-system/cn";
import { Radio } from "lucide-react";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  EVENTS_DRAFT_COMMIT,
  EVENTS_DRAFT_SOURCE_URL,
  EVENTS_PROFILES,
  getEventsProfile,
  usableDeliveryModes,
} from "@/lib/events-profiles";
import type { EventsProfileIdView } from "@/shared/events-api";

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-border px-5 py-5 last:border-b-0">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * "Draft" is a label, not a gate (per the events plan): the extension is a
 * working-group draft pinned at one commit, and every result is judged by a
 * named profile.
 */
export function DraftHeader({
  profileId,
  onProfileChange,
}: {
  profileId: EventsProfileIdView;
  onProfileChange: (profileId: EventsProfileIdView) => void;
}) {
  const profile = getEventsProfile(profileId);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <Radio className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold text-foreground">Events</h2>
      <a
        href={EVENTS_DRAFT_SOURCE_URL}
        target="_blank"
        rel="noreferrer"
        className="rounded-sm border border-pending/40 bg-pending/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:underline"
        title="MCP Events is a working-group draft; MCPJam implements the commit it is pinned to."
        data-testid="events-draft-badge"
      >
        Draft · {EVENTS_DRAFT_COMMIT}
      </a>
      <div className="ml-auto flex items-center gap-2">
        <label
          htmlFor="events-profile"
          className="text-[11px] text-muted-foreground"
        >
          Profile
        </label>
        <select
          id="events-profile"
          aria-label="Events profile"
          value={profileId}
          onChange={(e) =>
            onProfileChange(e.target.value as EventsProfileIdView)
          }
          className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          title={profile.description}
        >
          {EVENTS_PROFILES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function DeliveryChips({
  delivery,
  profileId,
}: {
  delivery: string[];
  profileId: EventsProfileIdView;
}) {
  const usable = new Set<string>(usableDeliveryModes(delivery, profileId));
  return (
    <div className="flex flex-wrap gap-1">
      {delivery.map((mode) => (
        <span
          key={mode}
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
            usable.has(mode)
              ? "border-border bg-secondary text-secondary-foreground"
              : "border-border text-muted-foreground line-through",
          )}
          title={
            usable.has(mode)
              ? undefined
              : `Not used by the ${getEventsProfile(profileId).label} profile`
          }
        >
          {mode}
        </span>
      ))}
    </div>
  );
}

export function SchemaViewer({
  label,
  schema,
}: {
  label: string;
  schema?: Record<string, unknown>;
}) {
  if (!schema) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {label}: none declared
      </p>
    );
  }
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        {label}
      </summary>
      <div className="mt-1 max-h-72 overflow-auto rounded-md border border-border">
        <JsonEditor
          value={schema}
          viewOnly
          collapsible
          defaultExpandDepth={3}
        />
      </div>
    </details>
  );
}
