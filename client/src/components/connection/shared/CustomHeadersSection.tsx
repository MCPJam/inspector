import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface CustomHeadersSectionProps {
  customHeaders: Array<{ key: string; value: string }>;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: "key" | "value", value: string) => void;
}

export function CustomHeadersSection({
  customHeaders,
  onAdd,
  onRemove,
  onUpdate,
}: CustomHeadersSectionProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          Custom Headers
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          Add Header
        </Button>
      </div>

      <div className="space-y-2">
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
    </div>
  );
}
