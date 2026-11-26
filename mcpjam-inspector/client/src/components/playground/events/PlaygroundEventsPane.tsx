import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import { useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Label } from "@mcpjam/design-system/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { EventTriggersTab } from "@/components/EventTriggersTab";
import { EVENT_TRIGGERS_API } from "@/lib/apis/event-triggers-api";
import { useCurrentSearchParam } from "@/lib/app-navigation";
import { EventDataView } from "@/components/events/EventsFeedPanel";
import { simulationDataFromSchema } from "@/components/events/event-utils";
import { AddPlaygroundEvent } from "./AddPlaygroundEvent";
import { bindingStatus } from "./binding-status";
import { EventConnectionCard } from "./EventConnectionCard";
import {
  usePlaygroundEvents,
  type PlaygroundEventBinding,
} from "./PlaygroundEventsProvider";

export function PlaygroundEventsPane() {
  const runtime = usePlaygroundEvents();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<{
    binding: PlaygroundEventBinding;
    mode: "test" | "edit";
  } | null>(null);
  if (!runtime) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium">
          Events {runtime.bindings.length || ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus className="mr-1 size-3.5" />
          Connect event
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {runtime.bindings.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">
            Connect a server event to see how your agent responds.
          </p>
        ) : (
          runtime.bindings.map((binding) => {
            const connected =
              runtime.servers[binding.serverName]?.connectionStatus ===
              "connected";
            const status = bindingStatus(binding, {
              connected,
              feedStatus: runtime.feed.status,
            });
            return (
              <EventConnectionCard
                key={binding.id}
                binding={binding}
                status={status}
                connected={connected}
                hosted={runtime.hosted}
                onTrigger={() => setSelected({ binding, mode: "test" })}
                onEdit={() => setSelected({ binding, mode: "edit" })}
                onTogglePause={() =>
                  void runtime
                    .edit(binding.id, { enabled: !binding.enabled })
                    .catch((error: unknown) =>
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Could not resume events. Try again.",
                      ),
                    )
                }
              />
            );
          })
        )}
        {runtime.feed.error ? (
          <p role="alert" className="text-xs text-destructive">
            {runtime.feed.error}
          </p>
        ) : null}
        <BackgroundRules projectId={runtime.projectId} />
      </div>
      {runtime.bindings.length > 0 ? (
        <p className="border-t p-3 text-[11px] text-muted-foreground">
          New event turns stop when you leave Playground. Events received while
          the agent is busy are skipped.
        </p>
      ) : null}
      {adding ? (
        <AddPlaygroundEvent
          runtime={runtime}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {selected ? (
        <BindingDialog
          key={`${selected.binding.id}:${selected.mode}`}
          {...selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function BindingDialog({
  binding,
  mode,
  onClose,
}: {
  binding: PlaygroundEventBinding;
  mode: "test" | "edit";
  onClose: () => void;
}) {
  const runtime = usePlaygroundEvents();
  const [value, setValue] = useState(
    mode === "edit"
      ? binding.instructions
      : JSON.stringify(
          simulationDataFromSchema(binding.event.payloadSchema),
          null,
          2,
        ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!runtime) return;
    if (mode === "edit") {
      await runtime.edit(binding.id, { instructions: value.trim() });
      onClose();
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(value);
    } catch {
      setError("Enter a valid JSON object for the event data.");
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      setError("Event data must be a JSON object.");
      return;
    }
    setBusy(true);
    const sent = await runtime.trigger(
      binding,
      data as Record<string, unknown>,
    );
    setBusy(false);
    if (sent) onClose();
    else
      setError(
        "Event was not sent. Check the connection and wait for the agent to finish, then try again.",
      );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "test" ? "Trigger event" : "Edit instructions"}
          </DialogTitle>
          <DialogDescription>
            {mode === "test"
              ? "Send test data to this Playground agent. This does not emit an event from your server."
              : `${binding.eventName} · ${binding.serverName}`}
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="event-value">
          {mode === "test" ? "Test event data" : "Instructions"}
        </Label>
        <Textarea
          id="event-value"
          rows={7}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={mode === "test" ? "font-mono text-xs" : ""}
        />
        {mode === "edit" ? (
          <details className="text-xs">
            <summary className="cursor-pointer py-2">
              Subscription details
            </summary>
            <EventDataView
              data={{
                event: binding.event,
                subscription: binding.subscription,
              }}
            />
          </details>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-between">
          <Button
            disabled={busy || !value.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Sending…" : mode === "test" ? "Trigger event" : "Save"}
          </Button>
          {mode === "edit" ? (
            <Button
              variant="ghost"
              onClick={() => {
                runtime?.remove(binding.id);
                onClose();
              }}
            >
              Disconnect from agent
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BackgroundRules({ projectId }: { projectId: string | null }) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const isMember = isAuthenticated && !!user;
  const legacy = useCurrentSearchParam("background") === "1";
  const triggerId = useCurrentSearchParam("triggerId");
  const rows = useQuery(
    EVENT_TRIGGERS_API.list,
    projectId && isMember ? { projectId } : "skip",
  );
  const [open, setOpen] = useState(legacy);
  if (!rows?.length && !legacy) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="w-full justify-start"
        onClick={() => setOpen(true)}
      >
        Background triggers {rows?.length ?? ""}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[85vh] max-w-[95vw] flex-col sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>Background triggers</DialogTitle>
            <DialogDescription>
              These saved rules run on MCPJam even when Playground is closed.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            <EventTriggersTab
              projectId={projectId}
              isSignedInMember={isMember}
              initialTriggerId={triggerId}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
