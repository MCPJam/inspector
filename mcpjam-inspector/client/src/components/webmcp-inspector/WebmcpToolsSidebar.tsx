import { useMemo, useRef, useState } from "react";
import {
  MoreHorizontal,
  PanelLeftClose,
  Play,
  RefreshCw,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { SearchInput } from "@/components/ui/search-input";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { ToolsPanel } from "./ToolsPanel";
import {
  ToolInvokePane,
  type ToolInvokeHandle,
} from "./ToolInvokePane";
import type { WebMcpToolDescriptor } from "@/shared/webmcp-inspector-protocol";

export interface WebmcpOverflowAction {
  label: string;
  onSelect: () => void;
  pressed?: boolean;
}

export interface WebmcpToolsSidebarProps {
  url: string;
  onUrlChange: (url: string) => void;
  onUrlSubmit: () => void;
  tools: WebMcpToolDescriptor[];
  selectedToolKey: string | undefined;
  onSelectTool: (toolKey: string | undefined) => void;
  hasSession: boolean;
  live: boolean;
  starting: boolean;
  pendingInvokeId: string | undefined;
  primaryLabel: string;
  primaryDisabled?: boolean;
  primaryTitle?: string;
  onPrimary: () => void;
  overflowActions: WebmcpOverflowAction[];
  onClose?: () => void;
  onInvoke: (input: Record<string, unknown>) => void;
  onCancel: (invokeId: string) => void;
}

export function WebmcpToolsSidebar({
  url,
  onUrlChange,
  onUrlSubmit,
  tools,
  selectedToolKey,
  onSelectTool,
  hasSession,
  live,
  starting,
  pendingInvokeId,
  primaryLabel,
  primaryDisabled,
  primaryTitle,
  onPrimary,
  overflowActions,
  onClose,
  onInvoke,
  onCancel,
}: WebmcpToolsSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const invokeRef = useRef<ToolInvokeHandle>(null);
  const selectedTool = tools.find((tool) => tool.toolKey === selectedToolKey);

  const filteredTools = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return tools;
    return tools.filter((tool) => {
      const haystack = `${tool.name} ${tool.description} ${tool.origin}`;
      return haystack.toLowerCase().includes(query);
    });
  }, [tools, searchQuery]);

  const showingForm = Boolean(selectedTool && live);

  return (
    <div className="flex h-full flex-col border-r border-border bg-background">
      <div className="flex-shrink-0 border-b border-border">
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="flex items-center gap-1.5">
            <span className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
              Tools
              <span className="ml-1 font-mono text-[10px] opacity-70">
                {tools.length}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            {overflowActions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="More actions"
                    title="More actions"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {overflowActions.map((action, index) => (
                    <DropdownMenuItem
                      key={`${action.label}-${index}`}
                      className="text-xs"
                      onSelect={action.onSelect}
                    >
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {onClose ? (
              <Button
                onClick={onClose}
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Hide sidebar"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
          <Button
            onClick={() => {
              if (showingForm) {
                invokeRef.current?.submit();
                return;
              }
              onPrimary();
            }}
            disabled={primaryDisabled || (showingForm && Boolean(pendingInvokeId))}
            size="sm"
            className="ml-auto h-8 px-3 text-xs"
            title={primaryTitle}
          >
            {starting || pendingInvokeId ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : showingForm ? (
              <Play className="h-3 w-3" />
            ) : null}
            <span className={showingForm || starting || pendingInvokeId ? "ml-1" : undefined}>
              {showingForm
                ? pendingInvokeId
                  ? "Running"
                  : "Invoke"
                : primaryLabel}
            </span>
          </Button>
        </div>
        <div className="px-2 pb-2">
          <Input
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              onUrlSubmit();
            }}
            placeholder="http://localhost:3000"
            className="h-8 font-mono text-xs"
            spellCheck={false}
            aria-label="Page URL to inspect"
          />
        </div>
      </div>

      {showingForm && selectedTool ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <SelectedToolHeader
            toolName={selectedTool.name}
            description={selectedTool.origin}
            onExpand={() => onSelectTool(undefined)}
            toolSwitchList={{
              items: tools.map((tool) => ({
                id: tool.toolKey,
                label: tool.name,
                description: tool.origin,
              })),
              selectedId: selectedTool.toolKey,
              onSelect: (toolKey) => onSelectTool(toolKey),
            }}
          />
          <ToolInvokePane
            key={selectedTool.toolKey}
            ref={invokeRef}
            tool={selectedTool}
            pendingInvokeId={pendingInvokeId}
            onInvoke={onInvoke}
            onCancel={onCancel}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {hasSession && tools.length > 0 ? (
            <div className="flex-shrink-0 border-b border-border px-2 py-2">
              <SearchInput
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder="Search tools..."
              />
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            <ToolsPanel
              tools={filteredTools}
              selectedToolKey={selectedToolKey}
              onSelect={onSelectTool}
              hasSession={hasSession}
            />
          </div>
        </div>
      )}
    </div>
  );
}
