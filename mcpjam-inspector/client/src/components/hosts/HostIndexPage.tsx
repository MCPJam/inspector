import { useState } from "react";
import { Plus, Loader2, Server } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useHostList, useHostMutations, type HostListItem } from "@/hooks/useClients";
import { HostCard } from "./HostCard";
import { CreateHostDialog } from "./CreateHostDialog";

interface HostIndexPageProps {
  projectId: string;
  isAuthenticated: boolean;
  onSelectHost: (hostId: string) => void;
}

export function HostIndexPage({
  projectId,
  isAuthenticated,
  onSelectHost,
}: HostIndexPageProps) {
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { deleteHost, duplicateHost } = useHostMutations();
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const handleDelete = async (host: HostListItem) => {
    setDeletingId(host.hostId);
    try {
      await deleteHost({ hostId: host.hostId });
      toast.success(`Host "${host.name}" deleted`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete host";
      if (msg.includes("consumer")) {
        toast.error(
          `${msg} — use force delete or remove dependent chatboxes/evals first`,
        );
      } else {
        toast.error(msg);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleDuplicate = async (host: HostListItem) => {
    setDuplicatingId(host.hostId);
    try {
      const { hostId } = await duplicateHost({ hostId: host.hostId });
      toast.success(`Host duplicated`);
      onSelectHost(hostId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate host");
    } finally {
      setDuplicatingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hosts</h1>
          <p className="text-sm text-muted-foreground">
            Named configurations combining a model, system prompt, and server
            selection.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Host
        </Button>
      </div>

      {hosts.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No hosts yet"
          description="Create a named host to reuse across Chat, Swarms, and Evals."
        >
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Host
          </Button>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {hosts.map((host) => (
            <HostCard
              key={host.hostId}
              host={host}
              onEdit={() => onSelectHost(host.hostId)}
              onDuplicate={() => handleDuplicate(host)}
              onDelete={() => handleDelete(host)}
              isDuplicating={duplicatingId === host.hostId}
              isDeleting={deletingId === host.hostId}
            />
          ))}
        </div>
      )}

      <CreateHostDialog
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        projectId={projectId}
        onCreated={(hostId) => onSelectHost(hostId)}
      />
    </div>
  );
}
