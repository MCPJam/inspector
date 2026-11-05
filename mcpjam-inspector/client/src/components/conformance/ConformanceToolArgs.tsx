/**
 * The arguments a conformance check sends with its tool. When the tool's
 * input schema lists its arguments, they are filled in as a form, one field
 * per argument, like the Playground and the Tools tab; nobody has to know the
 * names or write JSON. A tool whose schema takes no arguments shows nothing;
 * one with no schema at all (a saved tool the server no longer lists) keeps
 * the free-form editor.
 */
import { useEffect, useRef, useState } from "react";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { ToolCallArgsEditor } from "@/components/evals/checks-section";
import {
  applyParametersToFields,
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";

function hasListedArguments(schema: Record<string, unknown> | undefined) {
  const properties = schema?.properties;
  return (
    !!properties &&
    typeof properties === "object" &&
    Object.keys(properties).length > 0
  );
}

/** A field whose text cannot become its type: not sent, so the run must wait. */
function unparsable(field: FormField): boolean {
  if (!field.required && !field.isSet) return false;
  if (field.type === "number" || field.type === "integer")
    return field.value !== "" && Number.isNaN(Number(field.value));
  if (field.type === "array" || field.type === "object") {
    if (typeof field.value !== "string") return false;
    try {
      JSON.parse(field.value);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

export function ConformanceToolArgs({
  inputSchema,
  argProperties,
  value,
  onChange,
  onInvalidChange,
}: {
  inputSchema?: Record<string, unknown>;
  argProperties?: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const listed = hasListedArguments(inputSchema);
  // A tool whose schema takes no arguments gets nothing to fill in. Arguments
  // already saved for it would still be sent, so they stay visible to remove.
  if (inputSchema && !listed && Object.keys(value).length === 0) return null;
  if (!listed) {
    return (
      <ToolCallArgsEditor
        value={value}
        onChange={onChange}
        argProperties={argProperties}
        onInvalidChange={onInvalidChange}
      />
    );
  }
  return (
    <SchemaArgsForm
      inputSchema={inputSchema!}
      value={value}
      onChange={onChange}
      onInvalidChange={onInvalidChange}
    />
  );
}

function SchemaArgsForm({
  inputSchema,
  value,
  onChange,
  onInvalidChange,
}: {
  inputSchema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  // Fields keep their own drafts (a half-typed number, a JSON box mid-edit),
  // so they live here and the saved arguments follow them. The draft
  // remembers which arguments it is FOR: arguments replaced from elsewhere
  // (a reset, another row's choice) re-derive the fields, as
  // `RawArgsJsonEditor` does with its text.
  const valueKey = JSON.stringify(value);
  const fromValue = () =>
    applyParametersToFields(generateFormFieldsFromSchema(inputSchema), value);
  const [draft, setDraft] = useState(() => ({
    fields: fromValue(),
    forValue: valueKey,
  }));
  if (draft.forValue !== valueKey) {
    setDraft({ fields: fromValue(), forValue: valueKey });
  }
  const fields = draft.forValue === valueKey ? draft.fields : fromValue();
  // Saved arguments the schema does not list are kept, not silently dropped.
  const listed = new Set(fields.map((field) => field.name));
  const extras = Object.fromEntries(
    Object.entries(value).filter(([key]) => !listed.has(key)),
  );

  const onInvalidChangeRef = useRef(onInvalidChange);
  useEffect(() => {
    onInvalidChangeRef.current = onInvalidChange;
  });
  const invalid = fields.some(unparsable);
  useEffect(() => {
    onInvalidChangeRef.current(invalid);
  }, [invalid]);
  useEffect(() => () => onInvalidChangeRef.current(false), []);

  const update = (next: FormField[]) => {
    // An empty box is not an answer: a required one left empty stays out, so
    // the check keeps saying it needs input instead of sending "". A box that
    // does not parse stays out too, rather than going out as raw text.
    const filled = next.filter(
      (field) => field.value !== "" && !unparsable(field),
    );
    const args = { ...extras, ...buildParametersFromFields(filled) };
    setDraft({ fields: next, forValue: JSON.stringify(args) });
    onChange(args);
  };

  return (
    <ParametersForm
      fields={fields}
      onFieldChange={(name, fieldValue) =>
        update(
          fields.map((field) =>
            field.name === name
              ? { ...field, value: fieldValue, isSet: true }
              : field,
          ),
        )
      }
      onToggleField={(name, isSet) =>
        update(
          fields.map((field) =>
            field.name === name ? { ...field, isSet } : field,
          ),
        )
      }
    />
  );
}
