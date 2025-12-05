/**
 * PlaygroundToolsSidebar
 *
 * Left panel of the UI Playground with:
 * - Collapsible tool list (collapses when tool is selected)
 * - Dynamic parameters form
 * - Device/display mode controls at bottom
 */

import { useState, useEffect } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  Wrench,
  RefreshCw,
  Play,
  X,
  Smartphone,
  Tablet,
  Monitor,
  LayoutTemplate,
  PictureInPicture2,
  Maximize2,
  PanelLeftClose,
  Sun,
  Moon,
  Globe,
  Save,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SearchInput } from "../ui/search-input";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ScrollArea } from "../ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { SavedRequestItem } from "../tools/SavedRequestItem";
import type { FormField } from "@/lib/tool-form";
import type { SavedRequest } from "@/lib/types/request-types";
import type { DeviceType, DisplayMode, PlaygroundGlobals } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";

interface PlaygroundToolsSidebarProps {
  tools: Record<string, Tool>;
  toolNames: string[];
  filteredToolNames: string[];
  selectedToolName: string | null;
  fetchingTools: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onRefresh: () => void;
  onSelectTool: (name: string | null) => void;
  formFields: FormField[];
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
  isExecuting: boolean;
  onExecute: () => void;
  onSave: () => void;
  // Device emulation
  deviceType: DeviceType;
  displayMode: DisplayMode;
  onDeviceTypeChange: (type: DeviceType) => void;
  onDisplayModeChange: (mode: DisplayMode) => void;
  // Globals (theme, locale)
  globals: PlaygroundGlobals;
  onUpdateGlobal: <K extends keyof PlaygroundGlobals>(key: K, value: PlaygroundGlobals[K]) => void;
  // Saved requests
  savedRequests: SavedRequest[];
  filteredSavedRequests: SavedRequest[];
  highlightedRequestId: string | null;
  onLoadRequest: (req: SavedRequest) => void;
  onRenameRequest: (req: SavedRequest) => void;
  onDuplicateRequest: (req: SavedRequest) => void;
  onDeleteRequest: (id: string) => void;
  // Panel visibility
  onClose?: () => void;
}

export function PlaygroundToolsSidebar({
  tools,
  toolNames,
  filteredToolNames,
  selectedToolName,
  fetchingTools,
  searchQuery,
  onSearchQueryChange,
  onRefresh,
  onSelectTool,
  formFields,
  onFieldChange,
  onToggleField,
  isExecuting,
  onExecute,
  onSave,
  deviceType,
  displayMode,
  onDeviceTypeChange,
  onDisplayModeChange,
  globals,
  onUpdateGlobal,
  savedRequests,
  filteredSavedRequests,
  highlightedRequestId,
  onLoadRequest,
  onRenameRequest,
  onDuplicateRequest,
  onDeleteRequest,
  onClose,
}: PlaygroundToolsSidebarProps) {
  const selectedTool = selectedToolName ? tools[selectedToolName] : null;
  const [isListExpanded, setIsListExpanded] = useState(!selectedToolName);
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");

  // Theme from preferences store (for actual theme switching)
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeChange = (newTheme: "light" | "dark") => {
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  };

  // Collapse list when a tool is selected
  useEffect(() => {
    if (selectedToolName) {
      setIsListExpanded(false);
    }
  }, [selectedToolName]);

  // Expand list when no tool is selected
  useEffect(() => {
    if (!selectedToolName) {
      setIsListExpanded(true);
    }
  }, [selectedToolName]);

  return (
    <div className="h-full overflow-hidden">
      <div className="h-full flex flex-col border-r border-border bg-background">
        {/* Tabs Header */}
        <div className="border-b border-border flex-shrink-0">
          <div className="flex items-center">
            <button
              onClick={() => setActiveTab("tools")}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
                activeTab === "tools"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Tools
              <span className="ml-1 text-[10px] font-mono opacity-60">
                {toolNames.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab("saved")}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
                activeTab === "saved"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Saved
              {savedRequests.length > 0 && (
                <span className="ml-1 text-[10px] font-mono opacity-60">
                  {savedRequests.length}
                </span>
              )}
            </button>
            <div className="ml-auto flex items-center gap-1 pr-2">
              <Button
                onClick={onExecute}
                disabled={isExecuting || !selectedToolName}
                size="sm"
                className="h-7 px-2.5 text-xs"
              >
                {isExecuting ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                <span className="ml-1">Run</span>
              </Button>
              <Button
                onClick={onSave}
                disabled={!selectedToolName}
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Save request"
              >
                <Save className="h-3 w-3" />
              </Button>
              <div className="w-px h-4 bg-border mx-0.5" />
              <Button
                onClick={onRefresh}
                variant="ghost"
                size="sm"
                disabled={fetchingTools}
                className="h-7 w-7 p-0"
                title="Refresh tools"
              >
                <RefreshCw
                  className={`h-3 w-3 ${fetchingTools ? "animate-spin" : ""}`}
                />
              </Button>
              {onClose && (
                <Button
                  onClick={onClose}
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  title="Hide sidebar"
                >
                  <PanelLeftClose className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </div>

      {/* Middle Content Area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "saved" ? (
          // Saved Requests Tab
          <div className="h-full flex flex-col">
            {/* Search */}
            <div className="px-3 py-2 flex-shrink-0">
              <SearchInput
                value={searchQuery}
                onValueChange={onSearchQueryChange}
                placeholder="Search saved requests..."
              />
            </div>

            {/* Saved Requests List */}
            <ScrollArea className="flex-1">
              <div className="pb-2">
                {filteredSavedRequests.length === 0 ? (
                  <div className="text-center py-8 px-4">
                    <p className="text-xs text-muted-foreground">
                      {savedRequests.length === 0
                        ? "No saved requests yet. Execute a tool and save the request to see it here."
                        : "No saved requests match your search."}
                    </p>
                  </div>
                ) : (
                  filteredSavedRequests.map((request) => (
                    <SavedRequestItem
                      key={request.id}
                      request={request}
                      isHighlighted={highlightedRequestId === request.id}
                      onLoad={(req) => {
                        onLoadRequest(req);
                        setActiveTab("tools");
                      }}
                      onRename={onRenameRequest}
                      onDuplicate={onDuplicateRequest}
                      onDelete={onDeleteRequest}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        ) : isListExpanded ? (
          // Expanded state - show full tool list
          <div className="h-full flex flex-col">
            {/* Search */}
            <div className="px-3 py-2 flex-shrink-0">
              <SearchInput
                value={searchQuery}
                onValueChange={onSearchQueryChange}
                placeholder="Search tools..."
              />
            </div>

            {/* Tool List */}
            <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
              {fetchingTools ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
                  <p className="text-xs text-muted-foreground">
                    Loading tools...
                  </p>
                </div>
              ) : filteredToolNames.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-xs text-muted-foreground">
                    {toolNames.length === 0
                      ? "No tools found"
                      : "No tools match your search"}
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {filteredToolNames.map((name) => {
                    const tool = tools[name];
                    const isSelected = selectedToolName === name;

                    return (
                      <button
                        key={name}
                        onClick={() => {
                          if (isSelected) {
                            setIsListExpanded(false);
                          } else {
                            onSelectTool(name);
                          }
                        }}
                        className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                          isSelected
                            ? "bg-primary/10 border border-primary/30"
                            : "hover:bg-muted/50 border border-transparent"
                        }`}
                      >
                        <code className="text-xs font-mono font-medium truncate block">
                          {name}
                        </code>
                        {tool.description && (
                          <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                            {tool.description}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          // Collapsed state - show selected tool header + params form
          <div className="h-full flex flex-col">
            {/* Selected tool header */}
            <div className="border-b border-border bg-muted/30 flex-shrink-0 px-3 py-2 flex items-center gap-2">
              <button
                onClick={() => setIsListExpanded(true)}
                className="flex-1 min-w-0 hover:bg-muted/50 rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-left"
                title="Click to change tool"
              >
                <code className="text-xs font-mono font-medium text-foreground truncate block">
                  {selectedToolName}
                </code>
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground flex-shrink-0"
                onClick={() => onSelectTool(null)}
                title="Clear selection"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>

            {/* Parameters Form */}
            <div className="flex-1 min-h-0 overflow-auto px-3 py-3 space-y-3">
              {formFields.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No parameters required
                </p>
              ) : (
                formFields.map((field) => (
                  <div key={field.name} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs font-medium text-foreground">
                        {field.name}
                      </code>
                      {field.required && (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600 dark:text-amber-400"
                        >
                          required
                        </Badge>
                      )}
                      {!field.required && (
                        <label className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!field.isSet}
                            onChange={(e) =>
                              onToggleField(field.name, !e.target.checked)
                            }
                            className="w-3 h-3 rounded border-border accent-primary cursor-pointer"
                          />
                          <span>skip</span>
                        </label>
                      )}
                    </div>
                    {field.description && (
                      <p className="text-[10px] text-muted-foreground leading-relaxed">
                        {field.description}
                      </p>
                    )}
                    <div className="pt-0.5">
                      {field.type === "enum" ? (
                        <select
                          value={field.value}
                          onChange={(e) =>
                            onFieldChange(field.name, e.target.value)
                          }
                          disabled={!field.required && !field.isSet}
                          className="w-full h-8 bg-background border border-border rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {field.enum?.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "boolean" ? (
                        <div className="flex items-center gap-2 h-8">
                          <input
                            type="checkbox"
                            checked={field.value}
                            disabled={!field.required && !field.isSet}
                            onChange={(e) =>
                              onFieldChange(field.name, e.target.checked)
                            }
                            className="w-4 h-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <span className="text-xs text-foreground">
                            {field.value ? "true" : "false"}
                          </span>
                        </div>
                      ) : field.type === "array" || field.type === "object" ? (
                        <Textarea
                          value={
                            typeof field.value === "string"
                              ? field.value
                              : JSON.stringify(field.value, null, 2)
                          }
                          onChange={(e) =>
                            onFieldChange(field.name, e.target.value)
                          }
                          placeholder={`Enter ${field.type} as JSON`}
                          disabled={!field.required && !field.isSet}
                          className="font-mono text-xs min-h-[80px] bg-background border-border resize-y disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      ) : (
                        <Input
                          type={
                            field.type === "number" || field.type === "integer"
                              ? "number"
                              : "text"
                          }
                          value={field.value}
                          onChange={(e) =>
                            onFieldChange(field.name, e.target.value)
                          }
                          placeholder={`Enter ${field.name}`}
                          disabled={!field.required && !field.isSet}
                          className="bg-background border-border text-xs h-8 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Device & Display Mode Controls */}
      <div className="px-4 py-3 border-t border-border bg-background flex-shrink-0">
        <div className="flex items-center justify-center gap-3">
          {/* Device Type */}
          <ToggleGroup
            type="single"
            value={deviceType}
            onValueChange={(v) => v && onDeviceTypeChange(v as DeviceType)}
            className="gap-0.5"
          >
            <ToggleGroupItem value="mobile" aria-label="Mobile" title="Mobile (430×932)" className="h-8 w-8 p-0">
              <Smartphone className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="tablet" aria-label="Tablet" title="Tablet (820×1180)" className="h-8 w-8 p-0">
              <Tablet className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="desktop" aria-label="Desktop" title="Desktop (1280×800)" className="h-8 w-8 p-0">
              <Monitor className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="w-px h-5 bg-border" />

          {/* Display Mode */}
          <ToggleGroup
            type="single"
            value={displayMode}
            onValueChange={(v) => v && onDisplayModeChange(v as DisplayMode)}
            className="gap-0.5"
          >
            <ToggleGroupItem value="inline" aria-label="Inline" title="Inline mode" className="h-8 w-8 p-0">
              <LayoutTemplate className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="pip" aria-label="PiP" title="Picture-in-Picture mode" className="h-8 w-8 p-0">
              <PictureInPicture2 className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="fullscreen" aria-label="Fullscreen" title="Fullscreen mode" className="h-8 w-8 p-0">
              <Maximize2 className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="w-px h-5 bg-border" />

          {/* Theme Toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleThemeChange(themeMode === "dark" ? "light" : "dark")}
            className="h-8 w-8 p-0"
            title={`Switch to ${themeMode === "dark" ? "light" : "dark"} mode`}
          >
            {themeMode === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          {/* Locale Selector */}
          <div className="relative">
            <Globe className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <select
              value={globals.locale}
              onChange={(e) => onUpdateGlobal("locale", e.target.value)}
              className="h-8 pl-7 pr-2 text-xs bg-background border border-input rounded-md appearance-none cursor-pointer hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
              title="Locale"
            >
              <option value="en-US">EN</option>
              <option value="es-ES">ES</option>
              <option value="fr-FR">FR</option>
              <option value="de-DE">DE</option>
              <option value="ja-JP">JA</option>
              <option value="zh-CN">ZH</option>
              <option value="pt-BR">PT</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
