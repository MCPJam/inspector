import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";

export function ProviderKeyField({
  id,
  configured,
  value,
  onChange,
  placeholder = "sk-...",
  optional = false,
}: {
  id: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  optional?: boolean;
}) {
  const [replacing, setReplacing] = useState(false);
  if (configured && !replacing) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <span className="flex items-center gap-2 text-sm">
          <CheckCircle2 aria-hidden="true" className="size-4" />
          API key configured
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setReplacing(true)}
        >
          Replace key
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {configured ? "New API key" : "API Key"}
        {optional && !configured ? " (optional)" : ""}
      </label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {configured && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange("");
            setReplacing(false);
          }}
        >
          Keep existing key
        </Button>
      )}
    </div>
  );
}
