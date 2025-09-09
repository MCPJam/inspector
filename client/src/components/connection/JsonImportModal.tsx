import { useState, useRef } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import { Card } from "../ui/card";
import { Alert, AlertDescription } from "../ui/alert";
import { Upload, AlertCircle, CheckCircle } from "lucide-react";
import { parseJsonConfig, validateJsonConfig } from "@/lib/json-config-parser";
import { ServerFormData } from "@/shared/types.js";

interface JsonImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (servers: ServerFormData[]) => void;
}

export function JsonImportModal({
  isOpen,
  onClose,
  onImport,
}: JsonImportModalProps) {
  const [jsonContent, setJsonContent] = useState("");
  const [validationResult, setValidationResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/json" && !file.name.endsWith(".json")) {
      toast.error("Please select a valid JSON file");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setJsonContent(content);
      validateJson(content);
    };
    reader.readAsText(file);
  };

  const validateJson = (content: string) => {
    if (!content.trim()) {
      setValidationResult(null);
      return;
    }

    const result = validateJsonConfig(content);
    setValidationResult(result);
  };

  const handleJsonChange = (content: string) => {
    setJsonContent(content);
    validateJson(content);
  };

  const handleImport = async () => {
    if (!validationResult?.success) {
      toast.error("Please fix the JSON validation errors before importing");
      return;
    }

    setIsImporting(true);
    try {
      const servers = parseJsonConfig(jsonContent);
      if (servers.length === 0) {
        toast.error("No valid servers found in the JSON config");
        return;
      }

      onImport(servers);
      toast.success(`Successfully imported ${servers.length} server${servers.length === 1 ? '' : 's'}`);
      handleClose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to import servers: ${errorMessage}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleClose = () => {
    setJsonContent("");
    setValidationResult(null);
    setIsImporting(false);
    onClose();
  };


  const getValidationIcon = () => {
    if (!validationResult) return null;
    return validationResult.success ? (
      <CheckCircle className="h-4 w-4 text-green-500" />
    ) : (
      <AlertCircle className="h-4 w-4 text-red-500" />
    );
  };

  const getValidationMessage = () => {
    if (!validationResult) return null;
    return validationResult.success ? (
      <span className="text-green-600 dark:text-green-400">Valid JSON config</span>
    ) : (
      <span className="text-red-600 dark:text-red-400">{validationResult.error}</span>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex text-xl font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2" /> Import Servers from JSON
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          {/* File Upload Section */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Upload JSON File</Label>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2"
              >
                <Upload className="h-4 w-4" />
                Choose File
              </Button>
            </div>
          </div>

          {/* JSON Input Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">JSON Configuration</Label>
              {validationResult && (
                <div className="flex items-center gap-2 text-sm">
                  {getValidationIcon()}
                  {getValidationMessage()}
                </div>
              )}
            </div>
            <Textarea
              value={jsonContent}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder="Paste your JSON configuration here or upload a file..."
              className="min-h-[200px] font-mono text-sm"
            />
          </div>

          {/* Example Config */}
          <Card className="p-4 bg-muted/30">
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Example JSON Format:</h4>
              <pre className="text-xs text-muted-foreground overflow-x-auto">
{`{
  "mcpServers": {
    "weather": {
      "command": "/path/to/node",
      "args": ["/path/to/weather-server.js"]
    },
    "asana": {
      "type": "sse",
      "url": "https://mcp.asana.com/sse"
    }
  }
}`}
              </pre>
            </div>
          </Card>

          {/* Validation Alert */}
          {validationResult && !validationResult.success && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {validationResult.error}
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end space-x-2 pt-4 border-t">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            className="px-4"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleImport}
            disabled={!validationResult?.success || isImporting}
            className="px-4"
          >
            {isImporting ? "Importing..." : "Import Servers"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
