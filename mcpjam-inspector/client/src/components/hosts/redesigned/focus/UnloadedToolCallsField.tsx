import { Switch } from "@mcpjam/design-system/switch";
import { hostConfigField } from "@/lib/host-config-field-schema";
import { FieldRow } from "./primitives";

export function UnloadedToolCallsField(props: {
  value: boolean;
  disabled: boolean;
  discoveryOff: boolean;
  onChange: (value: boolean) => void;
}) {
  const field = hostConfigField("runUnloadedToolCalls");
  const description = props.discoveryOff
    ? `${field.description} Applies when progressive tools hide the tool list.`
    : field.description;
  return (
    <FieldRow
      label={field.label}
      description={description}
      control={
        <Switch
          checked={props.value}
          disabled={props.disabled}
          aria-label={field.label}
          onCheckedChange={props.onChange}
        />
      }
    />
  );
}
