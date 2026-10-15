import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { useProjectPlugins } from "@/hooks/usePluginImportApi";

/** Optional immutable bundle pins; ordinary server selection is independent. */
export function ProjectEnvironmentPluginsPicker({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  const plugins = useProjectPlugins(projectId);
  if (!plugins?.length && !value.length) return null;
  const choices =
    plugins?.filter((plugin) => plugin.enabled && plugin.activeVersionId) ?? [];
  const known = new Set(choices.map((plugin) => plugin.activeVersionId!));
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Imported plugins</Label>
      {choices.map((plugin) => {
        const id = plugin.activeVersionId!;
        return (
          <Label
            key={id}
            className="flex items-center gap-2 text-xs font-normal"
          >
            <Checkbox
              aria-label={plugin.displayName}
              checked={value.includes(id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...new Set([...value, id])]
                    : value.filter((pin) => pin !== id),
                )
              }
            />
            {plugin.displayName}
          </Label>
        );
      })}
      {value
        .filter((id) => !known.has(id))
        .map((id) => (
          <Label
            key={id}
            className="flex items-center gap-2 text-xs font-normal"
          >
            <Checkbox
              aria-label="Unavailable pinned plugin"
              checked
              disabled={disabled}
              onCheckedChange={() =>
                onChange(value.filter((pin) => pin !== id))
              }
            />
            Unavailable pinned plugin
          </Label>
        ))}
    </div>
  );
}
