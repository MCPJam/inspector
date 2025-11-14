import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight } from "lucide-react";

interface CustomHeadersSectionProps {
  customHeaders: Array<{ key: string; value: string }>;
  showCustomHeaders: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: "key" | "value", value: string) => void;
}

export function CustomHeadersSection({
  customHeaders,
  showCustomHeaders,
  onToggle,
  onAdd,
  onRemove,
  onUpdate,
}: CustomHeadersSectionProps) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {showCustomHeaders ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">
            Custom Headers
          </span>
          {customHeaders.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({customHeaders.length})
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="text-xs"
        >
          Add Header
        </Button>
      </button>

      {showCustomHeaders && customHeaders.length > 0 && (
        <div className="p-4 space-y-2 border-t border-border bg-muted/30 max-h-48 overflow-y-auto">
          {customHeaders.map((header, index) => (
            <div key={index} className="flex gap-2 items-center">
              <Input
                value={header.key}
                onChange={(e) => onUpdate(index, "key", e.target.value)}
                placeholder="Header-Name"
                className="flex-1 text-xs"
              />
              <Input
                value={header.value}
                onChange={(e) => onUpdate(index, "value", e.target.value)}
                placeholder="header-value"
                className="flex-1 text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onRemove(index)}
                className="px-2 text-xs"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}

      {!showCustomHeaders && (
        <div className="px-3 pb-3">
          <p className="text-xs text-muted-foreground">
            Add custom HTTP headers for your MCP server connection (e.g.
            API-Key, X-Custom-Header)
          </p>
        </div>
      )}
    </div>
  );
}
