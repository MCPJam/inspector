import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Label } from "@mcpjam/design-system/label";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { fieldLabel, type SchemaFormField } from "./field";

/** Keyboard hints only; controllers validate values before effects. */
const FORMAT_INPUT_TYPES: Record<string, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

/** Stateless controls; all server-supplied content stays plain text. */
export function SchemaFormFieldControl({
  field,
  id,
  value,
  error,
  disabled = false,
  onChange,
}: {
  field: SchemaFormField;
  id: string;
  value: unknown;
  error?: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const inputId = id;
  const errorId = `${inputId}-error`;
  const invalid = Boolean(error);
  const describedBy = invalid ? errorId : undefined;

  switch (field.kind) {
    case "enum": {
      // Radix reserves the empty string for its placeholder. Encode every
      // option by position so even a literal sentinel is an ordinary value.
      const options = field.options ?? [];
      const selected = options.findIndex((option) => option.value === value);
      return (
        <Select
          disabled={disabled}
          value={selected < 0 ? "" : `option-${selected}`}
          onValueChange={(encoded) => {
            const option = options.find(
              (_, index) => `option-${index}` === encoded,
            );
            if (option) onChange(option.value);
          }}
        >
          <SelectTrigger
            disabled={disabled}
            id={inputId}
            className="w-full"
            aria-invalid={invalid}
            aria-describedby={describedBy}
          >
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option, index) => (
              <SelectItem key={option.value} value={`option-${index}`}>
                {option.label || "Empty value"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    case "multi-enum": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div
          role="group"
          aria-label={fieldLabel(field)}
          aria-describedby={describedBy}
          className="space-y-2 py-1"
        >
          {field.options?.map((option) => {
            const optionId = `${inputId}-${option.value}`;
            return (
              <div key={option.value} className="flex items-center gap-2">
                <Checkbox
                  disabled={disabled}
                  id={optionId}
                  checked={selected.includes(option.value)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? selected.includes(option.value)
                          ? selected
                          : [...selected, option.value]
                        : selected.filter((value) => value !== option.value),
                    )
                  }
                />
                <Label htmlFor={optionId} className="text-sm font-normal">
                  {option.label}
                </Label>
              </div>
            );
          })}
        </div>
      );
    }

    case "boolean":
      return (
        <div className="flex items-center space-x-3 py-2">
          <input
            disabled={disabled}
            id={inputId}
            type="checkbox"
            aria-invalid={invalid}
            aria-describedby={describedBy}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2"
          />
          <span className="text-sm">{value ? "Enabled" : "Disabled"}</span>
        </div>
      );

    case "json":
      return (
        <Textarea
          disabled={disabled}
          id={inputId}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter value as JSON"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="font-mono text-sm h-20 resize-none"
        />
      );

    case "number":
    case "integer":
      return (
        <Input
          disabled={disabled}
          id={inputId}
          type="number"
          step={
            field.multipleOf &&
            Number.isFinite(field.multipleOf) &&
            field.multipleOf > 0
              ? field.multipleOf
              : field.kind === "integer"
              ? 1
              : "any"
          }
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${fieldLabel(field)}`}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="text-sm"
        />
      );

    case "string":
    default:
      return (
        <Input
          disabled={disabled}
          id={inputId}
          type={(field.format && FORMAT_INPUT_TYPES[field.format]) ?? "text"}
          onInput={
            field.format === "date" || field.format === "date-time"
              ? (event) => onChange(event.currentTarget.value)
              : undefined
          }
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${fieldLabel(field)}`}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="text-sm"
        />
      );
  }
}
