/**
 * ParametersForm
 *
 * Dynamic form for tool parameters with support for various field types
 */

import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { FormField } from "@/lib/tool-form";

interface ParametersFormProps {
  fields: FormField[];
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
}

export function ParametersForm({
  fields,
  onFieldChange,
  onToggleField,
}: ParametersFormProps) {
  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-8 px-3">
        No parameters required
      </p>
    );
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {fields.map((field) => (
        <ParameterField
          key={field.name}
          field={field}
          onFieldChange={onFieldChange}
          onToggleField={onToggleField}
        />
      ))}
    </div>
  );
}

interface ParameterFieldProps {
  field: FormField;
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
}

function ParameterField({
  field,
  onFieldChange,
  onToggleField,
}: ParameterFieldProps) {
  const isDisabled = !field.required && !field.isSet;

  return (
    <div className="space-y-1.5">
      {/* Field Header */}
      <div className="flex items-center gap-2">
        <code className="font-mono text-xs font-medium text-foreground">
          {field.name}
        </code>
        {field.required && (
          <Badge
            variant="outline"
            className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600 dark:text-amber-400"
          >
            required
          </Badge>
        )}
        {!field.required && (
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto cursor-pointer">
            <input
              type="checkbox"
              checked={!field.isSet}
              onChange={(e) => onToggleField(field.name, !e.target.checked)}
              className="w-3 h-3 rounded border-border accent-primary cursor-pointer"
            />
            <span>skip</span>
          </label>
        )}
      </div>

      {/* Field Description */}
      {field.description && (
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {field.description}
        </p>
      )}

      {/* Field Input */}
      <div className="pt-0.5">
        <FieldInput
          field={field}
          disabled={isDisabled}
          onFieldChange={onFieldChange}
        />
      </div>
    </div>
  );
}

interface FieldInputProps {
  field: FormField;
  disabled: boolean;
  onFieldChange: (name: string, value: unknown) => void;
}

function FieldInput({ field, disabled, onFieldChange }: FieldInputProps) {
  if (field.type === "enum") {
    return (
      <select
        value={field.value}
        onChange={(e) => onFieldChange(field.name, e.target.value)}
        disabled={disabled}
        className="w-full h-8 bg-background border border-border rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
      >
        {field.enum?.map((v, idx) => (
          <option key={`${v}-${idx}`} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="flex items-center gap-2 h-8">
        <input
          type="checkbox"
          checked={field.value}
          disabled={disabled}
          onChange={(e) => onFieldChange(field.name, e.target.checked)}
          className="w-4 h-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="text-xs text-foreground">
          {field.value ? "true" : "false"}
        </span>
      </div>
    );
  }

  if (field.type === "array" || field.type === "object") {
    return (
      <Textarea
        value={
          typeof field.value === "string"
            ? field.value
            : JSON.stringify(field.value, null, 2)
        }
        onChange={(e) => onFieldChange(field.name, e.target.value)}
        placeholder={`Enter ${field.type} as JSON`}
        disabled={disabled}
        className="font-mono text-xs min-h-[80px] bg-background border-border resize-y disabled:cursor-not-allowed disabled:opacity-50"
      />
    );
  }

  // Default: string, number, integer
  return (
    <Input
      type={
        field.type === "number" || field.type === "integer" ? "number" : "text"
      }
      value={field.value}
      onChange={(e) => onFieldChange(field.name, e.target.value)}
      placeholder={`Enter ${field.name}`}
      disabled={disabled}
      className="bg-background border-border text-xs h-8 disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
