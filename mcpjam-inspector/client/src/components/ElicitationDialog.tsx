import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Badge } from "@mcpjam/design-system/badge";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { MessageSquare, X, Check, RefreshCw } from "lucide-react";
import { DialogElicitation } from "./ToolsTab";
import {
  buildElicitationContent,
  fieldLabel,
  initialFormValues,
  parseElicitationSchema,
  validateField,
  type ElicitationField,
} from "./elicitation/schema";

interface ElicitationDialogProps {
  elicitationRequest: DialogElicitation | null;
  onResponse: (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>
  ) => Promise<void>;
  loading?: boolean;
}

/**
 * Input `type` per JSON Schema `format`. Purely a keyboard/affordance hint —
 * validation is still enforced by `validateField`, never by the browser.
 */
const FORMAT_INPUT_TYPES: Record<string, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

/**
 * MCP spec MUST: elicitation dialogs never render clickable URLs. Every value,
 * description and message below is rendered as plain text — no anchors, no
 * linkification, anywhere in this component.
 */
export function ElicitationDialog({
  elicitationRequest,
  onResponse,
  loading = false,
}: ElicitationDialogProps) {
  const requestId = elicitationRequest?.requestId;
  const schema = elicitationRequest?.schema;
  const fields = useMemo(
    () => parseElicitationSchema(schema),
    // Keyed on requestId, NOT the request object. Callers build that wrapper
    // inline, so it is a fresh reference on every parent render — and chat
    // surfaces rerender constantly while a turn streams. Depending on it made
    // `fields` new each time, which retriggered the reset effect below and
    // wiped whatever the user had typed. An elicitation is immutable: same id,
    // same schema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestId]
  );
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reset form state (and prefill schema defaults) when a DIFFERENT request
  // arrives — `fields` is now stable for the life of one request, so this no
  // longer fires on unrelated rerenders.
  useEffect(() => {
    setValues(initialFormValues(fields));
    setErrors({});
  }, [fields]);

  const updateFieldValue = (name: string, value: unknown) => {
    // Object.assign onto a null-prototype base, not a spread literal: field
    // names are server-chosen and a literal `{...prev, __proto__: v}` would
    // mutate the prototype instead of storing the answer.
    setValues((prev) =>
      Object.assign(Object.create(null), prev, { [name]: value })
    );
    // Clear a shown error as soon as the user edits the field; it is
    // re-evaluated on the next Accept.
    setErrors((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, name)) return prev;
      const next: Record<string, string> = Object.assign(
        Object.create(null),
        prev
      );
      delete next[name];
      return next;
    });
  };

  const toggleMultiValue = (
    field: ElicitationField,
    option: string,
    checked: boolean
  ) => {
    const current = Array.isArray(values[field.name])
      ? (values[field.name] as string[])
      : [];
    updateFieldValue(
      field.name,
      checked
        ? current.includes(option)
          ? current
          : [...current, option]
        : current.filter((v) => v !== option)
    );
  };

  const handleResponse = async (action: "accept" | "decline" | "cancel") => {
    if (action !== "accept") {
      await onResponse(action);
      return;
    }

    // Null-prototype: a field named `__proto__` would otherwise write to the
    // prototype, leaving Object.keys empty — the error would vanish and the
    // submit would go through unvalidated.
    const nextErrors: Record<string, string> = Object.create(null);
    for (const field of fields) {
      const error = validateField(field, values[field.name]);
      if (error) nextErrors[field.name] = error;
    }

    if (Object.keys(nextErrors).length > 0) {
      // Block submit and surface the errors inline.
      setErrors(nextErrors);
      return;
    }

    setErrors({});
    await onResponse(action, buildElicitationContent(fields, values));
  };

  const renderField = (field: ElicitationField) => {
    const inputId = `elicitation-field-${field.name}`;
    const errorId = `${inputId}-error`;
    const invalid = Boolean(errors[field.name]);
    const describedBy = invalid ? errorId : undefined;

    switch (field.kind) {
      case "enum":
        return (
          <Select
            value={(values[field.name] as string) ?? ""}
            onValueChange={(value) => updateFieldValue(field.name, value)}
          >
            <SelectTrigger
              id={inputId}
              className="w-full"
              aria-invalid={invalid}
              aria-describedby={describedBy}
            >
              <SelectValue placeholder="Select an option" />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case "multi-enum": {
        const selected = Array.isArray(values[field.name])
          ? (values[field.name] as string[])
          : [];
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
                    id={optionId}
                    checked={selected.includes(option.value)}
                    onCheckedChange={(checked) =>
                      toggleMultiValue(field, option.value, checked === true)
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
              id={inputId}
              type="checkbox"
              checked={Boolean(values[field.name])}
              onChange={(e) => updateFieldValue(field.name, e.target.checked)}
              className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2"
            />
            <span className="text-sm">
              {values[field.name] ? "Enabled" : "Disabled"}
            </span>
          </div>
        );

      case "json":
        return (
          <Textarea
            id={inputId}
            value={String(values[field.name] ?? "")}
            onChange={(e) => updateFieldValue(field.name, e.target.value)}
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
            id={inputId}
            type="number"
            step={field.kind === "integer" ? 1 : "any"}
            value={String(values[field.name] ?? "")}
            onChange={(e) => updateFieldValue(field.name, e.target.value)}
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
            id={inputId}
            type={(field.format && FORMAT_INPUT_TYPES[field.format]) ?? "text"}
            value={String(values[field.name] ?? "")}
            onChange={(e) => updateFieldValue(field.name, e.target.value)}
            placeholder={`Enter ${fieldLabel(field)}`}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            className="text-sm"
          />
        );
    }
  };

  return (
    <Dialog open={!!elicitationRequest} onOpenChange={() => {}}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <MessageSquare className="h-3 w-3" />
            <RequestingServer elicitationRequest={elicitationRequest} />
          </DialogTitle>
          <DialogDescription className="text-md font-bold">
            {elicitationRequest?.message}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {fields.map((field) => {
            const label = fieldLabel(field);
            const showRawKey = Boolean(
              field.title && field.title !== field.name
            );
            const error = errors[field.name];
            return (
              <div key={field.name}>
                <div className="flex items-start justify-between mb-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Label
                        htmlFor={`elicitation-field-${field.name}`}
                        className="text-sm font-medium"
                      >
                        {label}
                      </Label>
                      {showRawKey && (
                        <span className="text-xs font-mono text-muted-foreground">
                          {field.name}
                        </span>
                      )}
                      {field.required && (
                        <div
                          className="w-1.5 h-1.5 bg-red-500 rounded-full"
                          title="Required field"
                        />
                      )}
                    </div>
                    {field.description && (
                      <p className="text-xs text-muted-foreground">
                        {field.description}
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {field.kind}
                  </Badge>
                </div>
                {renderField(field)}
                {error && (
                  <p
                    id={`elicitation-field-${field.name}-error`}
                    className="text-destructive text-xs mt-1"
                  >
                    {error}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => handleResponse("cancel")}
            disabled={loading}
          >
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => handleResponse("decline")}
            disabled={loading}
          >
            Decline
          </Button>
          <Button onClick={() => handleResponse("accept")} disabled={loading}>
            {loading ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Spec MUST: "clients MUST provide UI that makes it clear which server is
 * requesting information".
 *
 * `serverName` is an untrusted, server-supplied display label; `serverId` is
 * the immutable local identifier and therefore the trusted anchor — it stays
 * visible whenever we have it, even when a prettier name exists. Callers that
 * supply neither (today's local-mode surfaces) get the generic header.
 */
function RequestingServer({
  elicitationRequest,
}: {
  elicitationRequest: DialogElicitation | null;
}) {
  const { serverId, serverName } = elicitationRequest ?? {};
  const displayName = serverName ?? serverId;

  if (!displayName) return <>Elicitation Request</>;

  return (
    <span className="flex items-center gap-1.5">
      <strong className="font-semibold">{displayName}</strong>
      {serverId && serverId !== displayName && (
        <span className="text-xs font-mono font-normal text-muted-foreground">
          {serverId}
        </span>
      )}
      <span className="font-normal">is requesting information</span>
    </span>
  );
}
