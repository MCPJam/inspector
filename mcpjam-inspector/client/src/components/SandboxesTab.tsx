import { useEffect, useState } from "react";
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
import { SandboxUsagePanel } from "@/components/sandboxes/SandboxUsagePanel";
import { SandboxEditor } from "@/components/sandboxes/SandboxEditor";
import {
  useSandbox,
  useSandboxList,
  useSandboxMutations,
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
  const [rightPaneView, setRightPaneView] = useState<"usage" | "edit">("usage");

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

  const handleSelectSandbox = (sandboxId: string) => {
    setSelectedSandboxId(sandboxId);
    setRightPaneView("usage");
  };

  const handleDelete = async () => {
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
                    <div
                      key={sandbox.sandboxId}
                      className={`mb-2 rounded-lg border px-3 py-3 transition-colors ${
                        isSelected
                          ? "border-primary/50 bg-primary/5"
                          : "border-transparent hover:bg-muted/50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectSandbox(sandbox.sandboxId)}
                        className="w-full text-left"
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
                      {isSelected && (
                        <div className="mt-2.5 flex items-center gap-1.5 border-t pt-2.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-xs"
                            onClick={() => setRightPaneView("edit")}
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-xs"
                            onClick={() => setIsShareOpen(true)}
                          >
                            <Share2 className="h-3 w-3" />
                            Share
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
                            onClick={() => void handleDelete()}
                          >
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
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
            ) : rightPaneView === "edit" && servers ? (
              <SandboxEditor
                sandbox={selectedSandbox}
                workspaceServers={servers}
                onBack={() => setRightPaneView("usage")}
                onDeleted={() => {
                  setSelectedSandboxId(null);
                  setRightPaneView("usage");
                }}
              />
            ) : (
              <SandboxUsagePanel sandbox={selectedSandbox} />
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
