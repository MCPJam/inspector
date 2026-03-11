import { useEffect, useMemo, useState } from "react";
import {
  Globe,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreateSandboxDialog } from "@/components/sandboxes/CreateSandboxDialog";
import { ShareSandboxDialog } from "@/components/sandboxes/ShareSandboxDialog";
import {
  useSandbox,
  useSandboxList,
  useSandboxMutations,
  type SandboxSettings,
} from "@/hooks/useSandboxes";
import { useWorkspaceServers } from "@/hooks/useViews";

interface SandboxesTabProps {
  workspaceId: string | null;
}

export function SandboxesTab({ workspaceId }: SandboxesTabProps) {
  const { isAuthenticated } = useConvexAuth();
  const { sandboxes, isLoading } = useSandboxList({
    isAuthenticated,
    workspaceId,
  });
  const { servers } = useWorkspaceServers({
    isAuthenticated,
    workspaceId,
  });
  const { deleteSandbox } = useSandboxMutations();

  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(
    null,
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [editingSandbox, setEditingSandbox] = useState<SandboxSettings | null>(
    null,
  );

  useEffect(() => {
    if (!sandboxes || sandboxes.length === 0) {
      setSelectedSandboxId(null);
      return;
    }

    setSelectedSandboxId((current) => {
      if (current && sandboxes.some((sandbox) => sandbox.sandboxId === current)) {
        return current;
      }
      return sandboxes[0]?.sandboxId ?? null;
    });
  }, [sandboxes]);

  const { sandbox: selectedSandbox, isLoading: isSandboxLoading } = useSandbox({
    isAuthenticated,
    sandboxId: selectedSandboxId,
  });

  const selectedServerNames = useMemo(
    () => selectedSandbox?.servers.map((server) => server.serverName).join(", "),
    [selectedSandbox],
  );

  const handleDeleteSandbox = async () => {
    if (!selectedSandbox) return;
    const shouldDelete = window.confirm(
      `Delete "${selectedSandbox.name}"? This will also delete persisted usage history.`,
    );
    if (!shouldDelete) return;

    try {
      await deleteSandbox({ sandboxId: selectedSandbox.sandboxId });
      toast.success("Sandbox deleted");
      setSelectedSandboxId(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete sandbox",
      );
    }
  };

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a workspace to manage sandboxes.
        </p>
      </div>
    );
  }

  return (
    <>
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={30} minSize={22} maxSize={40}>
          <div className="flex h-full flex-col border-r">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Sandboxes</h2>
                <p className="text-xs text-muted-foreground">
                  Hosted chat environments for demos and testing.
                </p>
              </div>
              <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {isLoading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !sandboxes || sandboxes.length === 0 ? (
                <div className="flex h-full items-center justify-center px-4 text-center">
                  <div>
                    <p className="text-sm font-medium">No sandboxes yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Create one to package a prompt, model, and server set into
                      a hosted environment.
                    </p>
                  </div>
                </div>
              ) : (
                sandboxes.map((sandbox) => {
                  const isSelected = sandbox.sandboxId === selectedSandboxId;
                  return (
                    <button
                      key={sandbox.sandboxId}
                      type="button"
                      onClick={() => setSelectedSandboxId(sandbox.sandboxId)}
                      className={`mb-2 w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                        isSelected
                          ? "border-primary/50 bg-primary/5"
                          : "border-transparent hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {sandbox.name}
                          </p>
                          {sandbox.description ? (
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {sandbox.description}
                            </p>
                          ) : null}
                        </div>
                        {sandbox.mode === "any_signed_in_with_link" ? (
                          <Globe className="mt-0.5 h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {sandbox.serverNames.map((serverName) => (
                          <Badge
                            key={`${sandbox.sandboxId}-${serverName}`}
                            variant="secondary"
                          >
                            {serverName}
                          </Badge>
                        ))}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={70}>
          <div className="flex h-full flex-col">
            {!selectedSandboxId ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  Select a sandbox to view details.
                </p>
              </div>
            ) : isSandboxLoading || selectedSandbox === undefined ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !selectedSandbox ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  Sandbox not found.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between border-b px-6 py-5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-xl font-semibold">
                        {selectedSandbox.name}
                      </h2>
                      <Badge variant="outline">
                        {selectedSandbox.mode === "any_signed_in_with_link"
                          ? "Link access"
                          : "Invite only"}
                      </Badge>
                      {selectedSandbox.allowGuestAccess ? (
                        <Badge variant="secondary">Guest access</Badge>
                      ) : null}
                    </div>
                    {selectedSandbox.description ? (
                      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                        {selectedSandbox.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setEditingSandbox(selectedSandbox)}
                    >
                      <Pencil className="mr-1.5 h-4 w-4" />
                      Edit
                    </Button>
                    <Button onClick={() => setIsShareOpen(true)}>
                      <Share2 className="mr-1.5 h-4 w-4" />
                      Share
                    </Button>
                  </div>
                </div>

                <div className="grid gap-6 overflow-y-auto px-6 py-5 lg:grid-cols-[1.2fr,0.8fr]">
                  <section className="space-y-5">
                    <div className="rounded-lg border p-4">
                      <p className="text-sm font-medium">System prompt</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                        {selectedSandbox.systemPrompt}
                      </p>
                    </div>

                    <div className="rounded-lg border p-4">
                      <p className="text-sm font-medium">Servers</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedServerNames}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {selectedSandbox.servers.map((server) => (
                          <Badge key={server.serverId} variant="secondary">
                            {server.serverName}
                            {server.useOAuth ? " · OAuth" : ""}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section className="space-y-4">
                    <div className="rounded-lg border p-4">
                      <p className="text-sm font-medium">Configuration</p>
                      <dl className="mt-3 space-y-2 text-sm">
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Model</dt>
                          <dd className="text-right">{selectedSandbox.modelId}</dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Temperature</dt>
                          <dd>{selectedSandbox.temperature.toFixed(2)}</dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            Tool approval
                          </dt>
                          <dd>
                            {selectedSandbox.requireToolApproval ? "Required" : "Off"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Members</dt>
                          <dd>
                            {
                              selectedSandbox.members.filter((member) => !member.revokedAt)
                                .length
                            }
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="rounded-lg border border-destructive/20 p-4">
                      <p className="text-sm font-medium text-destructive">
                        Danger zone
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Delete the sandbox and all persisted hosted chat usage.
                      </p>
                      <Button
                        variant="destructive"
                        className="mt-3"
                        onClick={() => void handleDeleteSandbox()}
                      >
                        <Trash2 className="mr-1.5 h-4 w-4" />
                        Delete sandbox
                      </Button>
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {workspaceId && servers ? (
        <CreateSandboxDialog
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          workspaceId={workspaceId}
          workspaceServers={servers}
          onSaved={(sandbox) => {
            setSelectedSandboxId(sandbox.sandboxId);
            setIsCreateOpen(false);
          }}
        />
      ) : null}

      {workspaceId && servers && editingSandbox ? (
        <CreateSandboxDialog
          isOpen={!!editingSandbox}
          onClose={() => setEditingSandbox(null)}
          workspaceId={workspaceId}
          workspaceServers={servers}
          sandbox={editingSandbox}
          onSaved={(sandbox) => {
            setEditingSandbox(null);
            setSelectedSandboxId(sandbox.sandboxId);
          }}
        />
      ) : null}

      {selectedSandbox ? (
        <ShareSandboxDialog
          isOpen={isShareOpen}
          onClose={() => setIsShareOpen(false)}
          sandbox={selectedSandbox}
          onUpdated={(sandbox) => {
            setSelectedSandboxId(sandbox.sandboxId);
          }}
        />
      ) : null}
    </>
  );
}
