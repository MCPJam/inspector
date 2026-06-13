import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import type { XaaResourceType } from "@/lib/xaa/types";
import type { RegistrationDraft } from "./wizard-draft";

interface BasicInfoStepProps {
  draft: RegistrationDraft;
  onChange: (updates: Partial<RegistrationDraft>) => void;
}

export function BasicInfoStep({ draft, onChange }: BasicInfoStepProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="xaa-reg-name">Name</Label>
        <Input
          id="xaa-reg-name"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="My resource server"
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <Label>Resource type</Label>
        <RadioGroup
          value={draft.resourceType}
          onValueChange={(value) =>
            onChange({ resourceType: value as XaaResourceType })
          }
          className="flex gap-4"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="mcp" id="xaa-reg-type-mcp" />
            <Label htmlFor="xaa-reg-type-mcp" className="font-normal">
              MCP server
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="rest" id="xaa-reg-type-rest" />
            <Label htmlFor="xaa-reg-type-rest" className="font-normal">
              REST API
            </Label>
          </div>
        </RadioGroup>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="xaa-reg-resource-url">Resource URL</Label>
        <Input
          id="xaa-reg-resource-url"
          value={draft.resourceUrl}
          onChange={(event) => onChange({ resourceUrl: event.target.value })}
          placeholder="https://your-server.example.com/mcp"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          The resource identifier the ID-JAG&apos;s{" "}
          <code className="font-mono">resource</code> claim points at.
        </p>
      </div>
    </div>
  );
}
