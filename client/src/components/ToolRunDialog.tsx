import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import DynamicJsonForm from "./DynamicJsonForm";
import type { JsonValue, JsonSchemaType } from "@/lib/utils/json/jsonUtils";
import { generateDefaultValue } from "@/lib/utils/json/schemaUtils";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Loader2, Send, Code2, Save, ClipboardPaste } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createMcpJamRequest,
  generateDefaultRequestName,
} from "@/lib/utils/json/requestUtils";
import { RequestStorage } from "@/lib/utils/request/requestStorage";
import {
  CreateMcpJamRequestInput,
  McpJamRequest,
  UpdateMcpJamRequestInput,
} from "@/lib/types/requestTypes";
import { tryParseJson } from "@/lib/utils/json/jsonUtils";

const INPUT_STYLES = {
  base: "font-mono text-xs bg-gradient-to-br from-background/80 to-background/60 border-border/40 rounded-lg focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all duration-200",
  container:
    "bg-gradient-to-br from-background/80 to-background/60 border border-border/40 rounded-lg hover:border-border/60 transition-all duration-200",
};

const initializeParams = (tool: Tool): Record<string, unknown> => {
  if (!tool?.inputSchema?.properties) return {};

  return Object.fromEntries(
    Object.entries(tool.inputSchema.properties).map(([key, value]) => [
      key,
      generateDefaultValue(value as JsonSchemaType),
    ]),
  );
};

const handleNumberInput = (
  value: string,
  params: Record<string, unknown>,
  key: string,
  setParams: (params: Record<string, unknown>) => void,
) => {
  if (value === "") {
    setParams({ ...params, [key]: undefined });
    return;
  }

  const numValue = Number(value);
  if (!isNaN(numValue)) {
    setParams({ ...params, [key]: numValue });
  }
};

const ToolDescription = ({ tool }: { tool: Tool | null }) =>
  tool?.description && (
    <p className="text-sm text-muted-foreground">{tool.description}</p>
  );

interface ParameterInputProps {
  paramKey: string;
  prop: JsonSchemaType;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}

const ParameterInput = ({
  paramKey,
  prop,
  value,
  onChange,
}: ParameterInputProps) => {
  const renderInput = () => {
    switch (prop.type) {
      case "boolean":
        return (
          <div className="flex items-center space-x-2 p-2.5 bg-gradient-to-r from-background/50 to-background/30 border border-border/30 rounded-lg hover:border-border/50 transition-all duration-200">
            <Checkbox
              id={paramKey}
              name={paramKey}
              checked={!!value}
              onCheckedChange={(checked: boolean) =>
                onChange(paramKey, checked)
              }
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary h-3.5 w-3.5"
            />
            <label
              htmlFor={paramKey}
              className="text-sm font-medium text-foreground cursor-pointer flex-1"
            >
              {prop.description || "Toggle this option"}
            </label>
          </div>
        );

      case "string":
        return (
          <Textarea
            id={paramKey}
            name={paramKey}
            placeholder={prop.description || `Enter ${paramKey}...`}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(paramKey, e.target.value)}
            className={`${INPUT_STYLES.base} min-h-[60px] resize-none p-2`}
          />
        );

      case "number":
      case "integer":
        return (
          <Input
            type="number"
            id={paramKey}
            name={paramKey}
            placeholder={prop.description || `Enter ${paramKey}...`}
            value={value !== undefined && value !== null ? String(value) : ""}
            onChange={(e) =>
              handleNumberInput(
                e.target.value,
                { [paramKey]: value },
                paramKey,
                (params) => onChange(paramKey, params[paramKey]),
              )
            }
            className={`${INPUT_STYLES.base} h-8`}
          />
        );

      case "object":
      case "array":
      default:
        return (
          <div className={INPUT_STYLES.container + " p-2.5"}>
            <DynamicJsonForm
              schema={{
                type: prop.type,
                properties: prop.properties,
                description: prop.description,
                items: prop.items,
              }}
              value={(value as JsonValue) ?? generateDefaultValue(prop)}
              onChange={(newValue: JsonValue) => onChange(paramKey, newValue)}
            />
          </div>
        );
    }
  };

  return (
    <div className="group">
      {/* Parameter Name */}
      <div className="flex items-center space-x-1.5 mb-2">
        <span className="font-mono text-sm bg-gradient-to-r from-secondary/80 to-secondary/60 px-2 py-1 rounded-md border border-border/30 text-foreground font-medium shadow-sm">
          {paramKey}
        </span>
        <span className="text-sm text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded font-medium">
          {prop.type}
        </span>
      </div>

      {/* Parameter Description */}
      {prop.description && (
        <p className="text-sm text-muted-foreground/80 mb-2 ml-0.5 italic">
          {prop.description}
        </p>
      )}

      {/* Input Field */}
      <div className="relative">{renderInput()}</div>
    </div>
  );
};

const ParametersSection = ({
  tool,
  params,
  onParamChange,
}: {
  tool: Tool;
  params: Record<string, unknown>;
  onParamChange: (key: string, value: unknown) => void;
}) => {
  const properties = tool.inputSchema.properties ?? {};

  if (Object.keys(properties).length === 0) return null;

  const handlePasteInputs = async () => {
    try {
      if (!navigator.clipboard) {
        alert(
          "Clipboard access is not available in this browser. Please use a modern browser with HTTPS.",
        );
        return;
      }

      const clipboardText = await navigator.clipboard.readText();

      if (!clipboardText.trim()) {
        alert("Clipboard is empty or contains no text.");
        return;
      }

      const parseResult = tryParseJson(clipboardText);

      if (!parseResult.success) {
        let fixedJson = clipboardText.trim();
        fixedJson = fixedJson.replace(/(\w+)(\s*:)/g, '"$1"$2');
        fixedJson = fixedJson.replace(/'/g, '"');

        const retryResult = tryParseJson(fixedJson);

        if (!retryResult.success) {
          alert(
            "Could not parse clipboard content as JSON. Please ensure the clipboard contains valid JSON data.",
          );
          return;
        }

        if (
          typeof retryResult.data === "object" &&
          retryResult.data !== null &&
          !Array.isArray(retryResult.data)
        ) {
          const jsonData = retryResult.data as Record<string, unknown>;

          Object.entries(jsonData).forEach(([key, value]) => {
            if (key in properties) {
              onParamChange(key, value);
            }
          });

          const matchedKeys = Object.keys(jsonData).filter(
            (key) => key in properties,
          );
          if (matchedKeys.length > 0) {
            alert(
              `Successfully populated ${matchedKeys.length} field(s): ${matchedKeys.join(", ")}`,
            );
          } else {
            alert("No matching fields found in the JSON data.");
          }
        } else {
          alert(
            "Clipboard content must be a JSON object, not an array or primitive value.",
          );
        }
        return;
      }

      if (
        typeof parseResult.data === "object" &&
        parseResult.data !== null &&
        !Array.isArray(parseResult.data)
      ) {
        const jsonData = parseResult.data as Record<string, unknown>;

        Object.entries(jsonData).forEach(([key, value]) => {
          if (key in properties) {
            onParamChange(key, value);
          }
        });

        const matchedKeys = Object.keys(jsonData).filter(
          (key) => key in properties,
        );
        if (matchedKeys.length > 0) {
          alert(
            `Successfully populated ${matchedKeys.length} field(s): ${matchedKeys.join(", ")}`,
          );
        } else {
          alert("No matching fields found in the JSON data.");
        }
      } else {
        alert(
          "Clipboard content must be a JSON object, not an array or primitive value.",
        );
      }
    } catch (error) {
      console.error("Failed to paste inputs:", error);
      if (error instanceof Error && error.name === "NotAllowedError") {
        alert(
          "Clipboard access denied. Please grant clipboard permissions or copy the content again.",
        );
      } else {
        alert("Failed to read from clipboard. Please try again.");
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pb-2 border-b border-border/20">
        <div className="flex items-center space-x-2">
          <Code2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Parameters
          </span>
        </div>
        <Button
          onClick={handlePasteInputs}
          variant="outline"
          size="sm"
          className="h-8 px-3 text-sm hover:bg-primary/10 hover:text-primary hover:border-primary/20 transition-all duration-200"
          title="Paste JSON from clipboard to populate input fields"
        >
          <ClipboardPaste className="w-4 h-4 mr-1" />
          Paste Inputs
        </Button>
      </div>

      <div className="space-y-4">
        {Object.entries(properties).map(([key, value]) => (
          <ParameterInput
            key={key}
            paramKey={key}
            prop={value as JsonSchemaType}
            value={params[key]}
            onChange={onParamChange}
          />
        ))}
      </div>
    </div>
  );
};

const ActionButtons = ({
  onSave,
  onRun,
  isRunning,
  isUpdating,
}: {
  onSave: () => void;
  onRun: () => void;
  isRunning: boolean;
  isUpdating: boolean;
}) => (
  <>
    <Button onClick={onSave} variant="outline">
      <Save className="w-4 h-4 mr-2" />
      {isUpdating ? "Update Request" : "Save Request"}
    </Button>

    <Button onClick={onRun} disabled={isRunning}>
      {isRunning ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Executing...
        </>
      ) : (
        <>
          <Send className="w-4 h-4 mr-2" />
          Run Tool
        </>
      )}
    </Button>
  </>
);

interface SaveDialogProps {
  isOpen: boolean;
  isUpdating: boolean;
  requestName: string;
  requestDescription: string;
  isSaving: boolean;
  onClose: () => void;
  onSave: () => void;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
}

const SaveDialog = ({
  isOpen,
  isUpdating,
  requestName,
  requestDescription,
  isSaving,
  onClose,
  onSave,
  onNameChange,
  onDescriptionChange,
}: SaveDialogProps) => {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isUpdating ? "Update Request" : "Save Request"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">
              Request Name
            </label>
            <Input
              value={requestName}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Enter request name..."
              className="text-sm"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">
              Description (optional)
            </label>
            <Textarea
              value={requestDescription}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Enter description..."
              className="text-sm min-h-[80px] resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button onClick={onSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {isUpdating ? "Updating..." : "Saving..."}
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                {isUpdating ? "Update" : "Save"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface ToolRunDialogProps {
  isOpen: boolean;
  tool: Tool | null;
  onClose: () => void;
  callTool: (name: string, params: Record<string, unknown>) => Promise<void>;
  loadedRequest?: McpJamRequest | null;
  selectedServerName: string;
}

const ToolRunDialog = ({
  isOpen,
  tool,
  onClose,
  callTool,
  loadedRequest,
  selectedServerName,
}: ToolRunDialogProps) => {
  // State
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [isToolRunning, setIsToolRunning] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveRequestName, setSaveRequestName] = useState("");
  const [saveRequestDescription, setSaveRequestDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [paramsInitialized, setParamsInitialized] = useState(false);
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);

  // Effects
  useEffect(() => {
    setParamsInitialized(false);
    setCurrentRequestId(null);
  }, [tool?.name]);

  useEffect(() => {
    if (loadedRequest && tool && loadedRequest.toolName === tool.name) {
      setParams(loadedRequest.parameters);
      setParamsInitialized(true);
      setCurrentRequestId(loadedRequest.id);
    } else if (tool) {
      if (!paramsInitialized) {
        setParams(initializeParams(tool));
        setParamsInitialized(true);
        setCurrentRequestId(null);
      } else if (!loadedRequest) {
        setCurrentRequestId(null);
      }
    }
  }, [tool, loadedRequest, paramsInitialized]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setParams({});
      setParamsInitialized(false);
      setCurrentRequestId(null);
      setShowSaveDialog(false);
      setSaveRequestName("");
      setSaveRequestDescription("");
    }
  }, [isOpen]);

  // Handlers
  const handleParamChange = (key: string, value: unknown) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveRequest = async () => {
    if (!tool) return;

    try {
      setIsSaving(true);

      if (currentRequestId) {
        const updateInput: UpdateMcpJamRequestInput = {
          parameters: params as Record<string, JsonValue>,
        };

        if (saveRequestName.trim()) updateInput.name = saveRequestName;
        if (saveRequestDescription.trim())
          updateInput.description = saveRequestDescription;

        RequestStorage.updateRequest(currentRequestId, updateInput);
      } else {
        const requestInput: CreateMcpJamRequestInput = {
          name:
            saveRequestName ||
            generateDefaultRequestName(
              tool,
              params as Record<string, JsonValue>,
            ),
          description: saveRequestDescription,
          toolName: tool.name,
          tool: tool,
          parameters: params as Record<string, JsonValue>,
          tags: [],
          isFavorite: false,
          clientId: selectedServerName,
        };

        const request = createMcpJamRequest(requestInput);
        RequestStorage.addRequest(request);
        setCurrentRequestId(request.id);
      }

      setShowSaveDialog(false);
      setSaveRequestName("");
      setSaveRequestDescription("");
      window.dispatchEvent(new CustomEvent("requestSaved"));

      // Auto-dismiss dialog after successful save
      onClose();
    } catch (error) {
      console.error("Failed to save request:", error);
      alert("Failed to save request. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenSaveDialog = () => {
    if (!tool) return;

    if (currentRequestId && loadedRequest) {
      setSaveRequestName(loadedRequest.name);
      setSaveRequestDescription(loadedRequest.description || "");
    } else {
      setSaveRequestName(
        generateDefaultRequestName(tool, params as Record<string, JsonValue>),
      );
      setSaveRequestDescription("");
    }
    setShowSaveDialog(true);
  };

  const handleRunTool = async () => {
    if (!tool) return;

    try {
      setIsToolRunning(true);
      await callTool(tool.name, params);

      // Auto-dismiss modal after successful tool execution
      onClose();
    } finally {
      setIsToolRunning(false);
    }
  };

  const isUpdatingExistingRequest = currentRequestId !== null;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{tool ? `Run ${tool.name}` : "Run Tool"}</DialogTitle>
            <ToolDescription tool={tool} />
          </DialogHeader>

          {/* Content - Scrollable */}
          <div className="overflow-y-auto flex-1 min-h-0 space-y-6 py-2">
            {tool && (
              <>
                <ParametersSection
                  tool={tool}
                  params={params}
                  onParamChange={handleParamChange}
                />
              </>
            )}
          </div>

          {/* Footer - Always visible */}
          <DialogFooter className="border-t pt-4 mt-4">
            <ActionButtons
              onSave={handleOpenSaveDialog}
              onRun={handleRunTool}
              isRunning={isToolRunning}
              isUpdating={isUpdatingExistingRequest}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SaveDialog
        isOpen={showSaveDialog}
        isUpdating={isUpdatingExistingRequest}
        requestName={saveRequestName}
        requestDescription={saveRequestDescription}
        isSaving={isSaving}
        onClose={() => setShowSaveDialog(false)}
        onSave={handleSaveRequest}
        onNameChange={setSaveRequestName}
        onDescriptionChange={setSaveRequestDescription}
      />
    </>
  );
};

export default ToolRunDialog;
