/**
 * PlaygroundToolsSidebar
 *
 * Left panel of the UI Playground with:
 * - Collapsible tool list (collapses when tool is selected)
 * - Dynamic parameters form
 * - Sticky execute button at bottom
 */

import { useState, useEffect } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Wrench, RefreshCw, Play, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SearchInput } from "../ui/search-input";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { FormField } from "@/lib/tool-form";

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
}: PlaygroundToolsSidebarProps) {
  const selectedTool = selectedToolName ? tools[selectedToolName] : null;
  const [isListExpanded, setIsListExpanded] = useState(!selectedToolName);

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
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-background flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Tools</h2>
          <Badge variant="secondary" className="text-[10px] font-mono px-1.5">
            {toolNames.length}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={onRefresh}
            variant="ghost"
            size="sm"
            disabled={fetchingTools}
            className="h-7 w-7 p-0"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${fetchingTools ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            onClick={onExecute}
            disabled={isExecuting || !selectedToolName}
            size="sm"
          >
            {isExecuting ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Execute</span>
          </Button>
        </div>
      </div>

      {/* Collapsible Tool Selection */}
      {selectedToolName && !isListExpanded ? (
        // Collapsed state - show selected tool with expand/clear options
        <div className="border-b border-border bg-muted/30 flex-shrink-0 px-4 py-2.5 flex items-center gap-2">
          <button
            onClick={() => setIsListExpanded(true)}
            className="flex-1 min-w-0 hover:bg-muted/50 rounded px-2 py-1 -mx-2 -my-1 transition-colors text-left"
            title="Click to change tool"
          >
            <code className="text-xs font-mono font-semibold text-foreground truncate block">
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
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        // Expanded state - show full tool list (takes all remaining space)
        <div
          className="flex-1 min-h-0 border-b border-border overflow-hidden flex flex-col"
        >
          {/* Search */}
          <div className="px-3 py-2 flex-shrink-0">
            <SearchInput
              value={searchQuery}
              onValueChange={onSearchQueryChange}
              placeholder="Search tools..."
            />
          </div>

          {/* Tool List */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-2 pb-2">
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
                            // Clicking selected tool collapses the list
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
          </ScrollArea>
        </div>
      )}

      {/* Parameters Form - hidden when list is expanded */}
      {!isListExpanded && (
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {selectedTool ? (
          <>
            {/* Form Fields */}
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-4">
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
            </ScrollArea>
          </>
        ) : (
          // No tool selected state - should not appear since list expands when no tool
          <div className="flex-1 flex items-center justify-center p-4">
            <div className="text-center">
              <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                <Wrench className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">
                Select a tool
              </p>
              <p className="text-xs text-muted-foreground">
                Choose a tool from the list to configure and execute
              </p>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
