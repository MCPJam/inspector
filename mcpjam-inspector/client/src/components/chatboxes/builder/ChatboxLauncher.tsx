import { useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import { Loader2, Server } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import { useHostList } from "@/hooks/useHosts";
import { useChatboxMutations, type ChatboxSettings } from "@/hooks/useChatboxes";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

interface ChatboxLauncherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  /**
   * Called after a chatbox has been created from the picked host. The
   * experience layer uses this to open the new chatbox in the builder.
   */
  onChatboxCreated: (chatbox: ChatboxSettings) => void;
}

/**
 * Pick a project host to create a chatbox from. The chatbox is created
 * immediately on select and resolves all execution config (model,
 * prompt, servers) live through the chosen host. No multi-step builder
 * draft anymore — name + host is the entire create flow.
 */
export function ChatboxLauncher({
  open,
  onOpenChange,
  projectId,
  onChatboxCreated,
}: ChatboxLauncherProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const { createChatbox } = useChatboxMutations();
  const [creating, setCreating] = useState<string | null>(null);

  const handleSelect = async (hostId: string, hostName: string) => {
    if (!projectId || creating) return;
    setCreating(hostId);
    try {
      const next = (await createChatbox({
        projectId,
        name: `${hostName} chatbox`,
        namedHostId: hostId,
      })) as ChatboxSettings;
      onChatboxCreated(next);
      onOpenChange(false);
      toast.success("Chatbox created");
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to create chatbox"));
    } finally {
      setCreating(null);
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create chatbox"
      description="Pick a host to create the chatbox from."
      className="max-w-2xl"
    >
      <div className="border-b border-border/70 bg-muted/20 px-5 py-5">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          New chatbox
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-foreground">
          Pick a host
        </h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Chatboxes reuse a host's model, prompt, and servers. Edits to the
          host propagate to every chatbox pointing at it.
        </p>
      </div>

      <CommandInput placeholder="Search hosts..." />
      <CommandList className="max-h-[420px]">
        {isLoading ? (
          <div className="flex items-center justify-center px-4 py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading hosts…
          </div>
        ) : (
          <>
            <CommandEmpty>
              No hosts in this project yet. Create one in the Hosts tab first.
            </CommandEmpty>
            <CommandGroup heading="Project hosts">
              {hosts.map((host) => {
                const isThisCreating = creating === host.hostId;
                const isOtherCreating =
                  creating !== null && creating !== host.hostId;
                return (
                  <CommandItem
                    key={host.hostId}
                    value={`${host.name} ${host.modelId}`}
                    onSelect={() => handleSelect(host.hostId, host.name)}
                    disabled={isOtherCreating}
                    className="items-start gap-4 rounded-xl px-4 py-4"
                  >
                    <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/40">
                      {isThisCreating ? (
                        <Loader2 className="size-4.5 animate-spin" />
                      ) : (
                        <Server className="size-4.5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        {host.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {host.modelId || "No model set"}
                        <span className="mx-1.5 text-muted-foreground/40">
                          ·
                        </span>
                        {host.serverCount} server
                        {host.serverCount === 1 ? "" : "s"}
                      </p>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
