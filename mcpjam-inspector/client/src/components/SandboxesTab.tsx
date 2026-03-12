import { useEffect, useState } from "react";
import {
  Copy,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SandboxUsagePanel } from "@/components/sandboxes/SandboxUsagePanel";
import { SandboxEditor } from "@/components/sandboxes/SandboxEditor";
import {
  useSandbox,
  useSandboxList,
  useSandboxMutations,
  type SandboxListItem,
  type SandboxSettings,
} from "@/hooks/useSandboxes";
import { useWorkspaceServers } from "@/hooks/useViews";
import { copyToClipboard } from "@/lib/clipboard";
import { buildSandboxLink } from "@/lib/sandbox-session";

interface SandboxesTabProps {
  workspaceId: string | null;
}

type RightPaneView = "usage" | "edit" | "create";
type SandboxActionTarget = Pick<SandboxListItem, "sandboxId" | "name">;

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
  const { deleteSandbox, duplicateSandbox } = useSandboxMutations();

  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(
    null,
  );
  const [rightPaneView, setRightPaneView] = useState<RightPaneView>("usage");

  useEffect(() => {
    if (!sandboxes || sandboxes.length === 0) {
      setSelectedSandboxId(null);
      return;
    }

    setSelectedSandboxId((current) => {
      if (
        current &&
        sandboxes.some((sandbox) => sandbox.sandboxId === current)
      ) {
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

  const handleDelete = async (sandbox: SandboxActionTarget) => {
    const shouldDelete = window.confirm(
      `Delete "${sandbox.name}"? This will also delete persisted usage history.`,
    );
    if (!shouldDelete) return;

    try {
      await deleteSandbox({ sandboxId: sandbox.sandboxId });
      toast.success("Sandbox deleted");
      if (sandbox.sandboxId === selectedSandboxId) {
        setSelectedSandboxId(null);
        setRightPaneView("usage");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete sandbox",
      );
    }
  };

  const handleDuplicate = async (sandbox: SandboxActionTarget) => {
    try {
      const duplicatedSandbox = (await duplicateSandbox({
        sandboxId: sandbox.sandboxId,
      })) as SandboxSettings;
      toast.success(`Sandbox duplicated as "${duplicatedSandbox.name}"`);
      handleCreated(duplicatedSandbox);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to duplicate sandbox",
      );
    }
  };

  const handleCreated = (sandbox: SandboxSettings) => {
    setSelectedSandboxId(sandbox.sandboxId);
    setRightPaneView("usage");
  };

  const resolveSandboxLink = (sandbox: SandboxActionTarget) => {
    if (sandbox.sandboxId !== selectedSandboxId) {
      handleSelectSandbox(sandbox.sandboxId);
      return null;
    }

    const token = selectedSandbox?.link?.token?.trim();
    return token ? buildSandboxLink(token, sandbox.name) : null;
  };

  const handleOpenSandbox = (sandbox: SandboxActionTarget) => {
    const shareLink = resolveSandboxLink(sandbox);
    if (!shareLink) {
      if (sandbox.sandboxId === selectedSandboxId) {
        toast.error("Sandbox link unavailable");
      }
      return;
    }

    window.open(shareLink, "_blank");
  };

  const handleCopySandboxLink = async (sandbox: SandboxActionTarget) => {
    const shareLink = resolveSandboxLink(sandbox);
    if (!shareLink) {
      if (sandbox.sandboxId === selectedSandboxId) {
        toast.error("Sandbox link unavailable");
      }
      return;
    }

    const didCopy = await copyToClipboard(shareLink);
    if (didCopy) {
      toast.success("Sandbox link copied");
      return;
    }

    toast.error("Failed to copy link");
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
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel defaultSize={30} minSize={22} maxSize={40}>
        <div className="flex h-full flex-col border-r">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Sandboxes</h2>
              <p className="text-xs text-muted-foreground">
                Hosted chat environments
              </p>
            </div>
            <Button size="sm" onClick={() => setRightPaneView("create")}>
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
                    Create one to package a prompt, model, and server set into a
                    hosted environment.
                  </p>
                </div>
              </div>
            ) : (
              sandboxes.map((sandbox) => {
                const isSelected = sandbox.sandboxId === selectedSandboxId;
                return (
                  <div
                    key={sandbox.sandboxId}
                    className={`mb-1 cursor-pointer rounded-lg px-3 py-2.5 transition-colors ${
                      isSelected ? "bg-muted/50" : "hover:bg-muted/40"
                    }`}
                    onClick={() => handleSelectSandbox(sandbox.sandboxId)}
                  >
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">
                        {sandbox.name}
                      </p>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground"
                          aria-label="Copy sandbox link"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopySandboxLink(sandbox);
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground"
                          aria-label="Open sandbox"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenSandbox(sandbox);
                          }}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
                            aria-label="Sandbox actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectSandbox(sandbox.sandboxId);
                              setRightPaneView("edit");
                            }}
                          >
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDuplicate(sandbox);
                            }}
                          >
                            <Copy className="mr-2 h-3.5 w-3.5" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDelete(sandbox);
                            }}
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {sandbox.description ? (
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                        {sandbox.description}
                      </p>
                    ) : null}
                    {sandbox.serverNames.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {sandbox.serverNames.map((serverName) => (
                          <Badge
                            key={`${sandbox.sandboxId}-${serverName}`}
                            variant="outline"
                            className="text-[11px] text-muted-foreground"
                          >
                            {serverName}
                          </Badge>
                        ))}
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
          {rightPaneView === "create" && servers ? (
            <SandboxEditor
              workspaceId={workspaceId}
              workspaceServers={servers}
              onBack={() => setRightPaneView("usage")}
              onSaved={handleCreated}
            />
          ) : !selectedSandboxId ? (
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
              workspaceId={workspaceId}
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
  );
}
