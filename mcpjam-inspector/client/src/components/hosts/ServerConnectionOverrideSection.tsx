import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Label } from "@mcpjam/design-system/label";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

interface ServerEntry {
  id: string;
  name: string;
}

interface Override {
  headersOverride?: Record<string, string>;
  requestTimeoutOverride?: number;
}

interface ServerConnectionOverrideSectionProps {
  serverIds: string[];
  optionalServerIds: string[];
  projectServers: ServerEntry[];
  overrides: Record<string, Override>;
  onChange: (overrides: Record<string, Override>) => void;
  onServerSelectionChange: (serverIds: string[], optionalServerIds: string[]) => void;
}

function HeadersEditor({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (h: Record<string, string>) => void;
}) {
  const [rawJson, setRawJson] = useState(() => JSON.stringify(headers, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  const handleChange = (value: string) => {
    setRawJson(value);
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("Must be a JSON object");
        return;
      }
      setParseError(null);
      onChange(parsed as Record<string, string>);
    } catch {
      setParseError("Invalid JSON");
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">Headers override (JSON)</Label>
      <textarea
        className={cn(
          "min-h-[80px] w-full rounded-md border bg-background px-3 py-2 font-mono text-xs",
          parseError ? "border-destructive" : "border-input",
        )}
        value={rawJson}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
      />
      {parseError && (
        <p className="text-xs text-destructive">{parseError}</p>
      )}
    </div>
  );
}

function ServerOverrideRow({
  server,
  isRequired,
  isOptional,
  override,
  onRequiredChange,
  onOptionalChange,
  onOverrideChange,
}: {
  server: ServerEntry;
  isRequired: boolean;
  isOptional: boolean;
  override: Override | undefined;
  onRequiredChange: (checked: boolean) => void;
  onOptionalChange: (checked: boolean) => void;
  onOverrideChange: (override: Override | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverride = override !== undefined;

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center gap-3 px-3 py-2">
        <Checkbox
          id={`req-${server.id}`}
          checked={isRequired}
          onCheckedChange={(checked) => onRequiredChange(!!checked)}
        />
        <Label htmlFor={`req-${server.id}`} className="flex-1 cursor-pointer text-sm font-medium">
          {server.name}
        </Label>
        <Checkbox
          id={`opt-${server.id}`}
          checked={isOptional}
          onCheckedChange={(checked) => onOptionalChange(!!checked)}
          title="Optional"
        />
        <Label htmlFor={`opt-${server.id}`} className="cursor-pointer text-xs text-muted-foreground">
          Optional
        </Label>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setExpanded((v) => !v)}
          title="Per-server overrides"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
      </div>

      {expanded && (
        <div className="border-t px-3 py-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id={`override-${server.id}`}
              checked={hasOverride}
              onCheckedChange={(checked) =>
                onOverrideChange(checked ? {} : undefined)
              }
            />
            <Label htmlFor={`override-${server.id}`} className="text-xs">
              {hasOverride ? "Override active" : "Using host defaults"}
            </Label>
          </div>
          {hasOverride && (
            <>
              <HeadersEditor
                headers={override?.headersOverride ?? {}}
                onChange={(h) =>
                  onOverrideChange({ ...override, headersOverride: h })
                }
              />
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Timeout override (ms)</Label>
                <Input
                  type="number"
                  placeholder="Using host default"
                  value={override?.requestTimeoutOverride ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    onOverrideChange({
                      ...override,
                      requestTimeoutOverride: val ? Number(val) : undefined,
                    });
                  }}
                  className="h-8 text-xs"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ServerConnectionOverrideSection({
  serverIds,
  optionalServerIds,
  projectServers,
  overrides,
  onChange,
  onServerSelectionChange,
}: ServerConnectionOverrideSectionProps) {
  if (projectServers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No servers in this project yet. Add a server to configure it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {projectServers.map((server) => (
        <ServerOverrideRow
          key={server.id}
          server={server}
          isRequired={serverIds.includes(server.id)}
          isOptional={optionalServerIds.includes(server.id)}
          override={overrides[server.id]}
          onRequiredChange={(checked) => {
            const newRequired = checked
              ? [...serverIds, server.id]
              : serverIds.filter((id) => id !== server.id);
            // can't be both required and optional
            const newOptional = checked
              ? optionalServerIds.filter((id) => id !== server.id)
              : optionalServerIds;
            onServerSelectionChange(newRequired, newOptional);
          }}
          onOptionalChange={(checked) => {
            const newOptional = checked
              ? [...optionalServerIds, server.id]
              : optionalServerIds.filter((id) => id !== server.id);
            // can't be both required and optional
            const newRequired = checked
              ? serverIds.filter((id) => id !== server.id)
              : serverIds;
            onServerSelectionChange(newRequired, newOptional);
          }}
          onOverrideChange={(override) => {
            const next = { ...overrides };
            if (override === undefined) {
              delete next[server.id];
            } else {
              next[server.id] = override;
            }
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
