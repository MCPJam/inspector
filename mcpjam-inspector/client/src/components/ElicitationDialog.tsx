import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PluginFormFields,
  type PluginFormPorts,
} from "./schema-form/PluginFormFields";
import {
  compilePluginForm,
  initialPluginFormValues,
  buildPluginFormContent,
  validatePluginFormContent,
  type PluginFormProfile,
} from "@/shared/plugin-extensions/form-plan";
import { PluginDescribedError } from "@/shared/plugin-operation";
import { SchemaFormFieldControl } from "./schema-form/SchemaFormFieldControl";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Badge } from "@mcpjam/design-system/badge";
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
  patternHint,
  validateField,
} from "./elicitation/schema";

interface ElicitationDialogProps {
  elicitationRequest: DialogElicitation | null;
  onResponse: (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>,
  ) => Promise<void>;
  loading?: boolean;
  /** Explicit trusted extension composition. Ordinary MCP forms retain their controller. */
  pluginForm?: {
    profile: PluginFormProfile;
    ports?: PluginFormPorts;
    presentation?: ReactNode;
  };
}

/**
 * MCP spec MUST: elicitation dialogs never render clickable URLs. Every value,
 * description and message below is rendered as plain text — no anchors, no
 * linkification, anywhere in this component.
 */
/**
 * Every map keyed by a SERVER-chosen field name must start life without a
 * prototype. `{}` inherits from Object.prototype, so a field legitimately named
 * `__proto__` makes `errors["__proto__"]` resolve to Object.prototype itself —
 * truthy, so the dialog marks the field invalid and then hands that object to
 * React to render, which throws. Same trap for `values`.
 */
function emptyFieldMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function ElicitationDialog({
  elicitationRequest,
  onResponse,
  loading = false,
  pluginForm,
}: ElicitationDialogProps) {
  const requestId = elicitationRequest?.requestId;
  const schema = elicitationRequest?.schema;
  const pluginProfileKey = JSON.stringify([
    pluginForm?.profile,
    !!pluginForm?.ports?.chooseResources,
    !!pluginForm?.ports?.preview,
  ]);
  const pluginPlan = useMemo(() => {
    if (!pluginForm) return;
    try {
      return compilePluginForm(schema, {
        ...pluginForm.profile,
        userResources:
          pluginForm.profile.userResources &&
          !!pluginForm.ports?.chooseResources,
        previews: pluginForm.profile.previews && !!pluginForm.ports?.preview,
      });
    } catch {
      return;
    }
    // A request is immutable; a different owned request starts a fresh controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, pluginProfileKey]);
  const fields = useMemo(
    () => parseElicitationSchema(schema),
    // Keyed on requestId, NOT the request object. Callers build that wrapper
    // inline, so it is a fresh reference on every parent render — and chat
    // surfaces rerender constantly while a turn streams. Depending on it made
    // `fields` new each time, which retriggered the reset effect below and
    // wiped whatever the user had typed. An elicitation is immutable: same id,
    // same schema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestId],
  );
  const [values, setValues] = useState<Record<string, unknown>>(emptyFieldMap);
  const [errors, setErrors] = useState<Record<string, string>>(emptyFieldMap);
  const [pluginPending, setPluginPending] = useState(false);
  const [pluginAnswered, setPluginAnswered] = useState(false);
  const [pluginError, setPluginError] = useState<string>();
  const responding = useRef(false);
  const currentRequest = useRef(requestId);
  currentRequest.current = requestId;

  // Reset form state (and prefill schema defaults) when a DIFFERENT request
  // arrives — `fields` is now stable for the life of one request, so this no
  // longer fires on unrelated rerenders.
  useEffect(() => {
    setValues(
      pluginPlan
        ? initialPluginFormValues(pluginPlan)
        : initialFormValues(fields),
    );
    setErrors(emptyFieldMap());
    setPluginPending(false);
    setPluginAnswered(false);
    setPluginError(undefined);
    responding.current = false;
  }, [fields, pluginPlan]);

  const updateFieldValue = (name: string, value: unknown) => {
    // Object.assign onto a null-prototype base, not a spread literal: field
    // names are server-chosen and a literal `{...prev, __proto__: v}` would
    // mutate the prototype instead of storing the answer.
    setValues((prev) =>
      Object.assign(emptyFieldMap(), prev, { [name]: value }),
    );
    // Clear a shown error as soon as the user edits the field; it is
    // re-evaluated on the next Accept.
    setErrors((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, name)) return prev;
      const next: Record<string, string> = Object.assign(emptyFieldMap(), prev);
      delete next[name];
      return next;
    });
  };

  const handleResponse = async (action: "accept" | "decline" | "cancel") => {
    if (pluginForm) {
      if (loading || pluginAnswered || responding.current) return;
      let content: Record<string, unknown> | undefined;
      if (action === "accept") {
        if (!pluginPlan) return;
        content = buildPluginFormContent(pluginPlan, values);
        const checked = validatePluginFormContent(pluginPlan, content);
        setErrors(checked.errors);
        setPluginError(checked.error);
        if (!checked.valid) return;
      }
      responding.current = true;
      setPluginPending(true);
      setPluginError(undefined);
      try {
        await onResponse(action, content);
        if (currentRequest.current === requestId) setPluginAnswered(true);
      } catch (error) {
        if (currentRequest.current === requestId)
          setPluginError(
            error instanceof PluginDescribedError
              ? error.message
              : "The answer could not be submitted. Try again.",
          );
      } finally {
        if (currentRequest.current === requestId) {
          responding.current = false;
          setPluginPending(false);
        }
      }
      return;
    }
    if (action !== "accept") {
      await onResponse(action);
      return;
    }

    // Null-prototype: a field named `__proto__` would otherwise write to the
    // prototype, leaving Object.keys empty — the error would vanish and the
    // submit would go through unvalidated.
    const nextErrors: Record<string, string> = emptyFieldMap();
    for (const field of fields) {
      const error = validateField(field, values[field.name]);
      if (error) nextErrors[field.name] = error;
    }

    if (Object.keys(nextErrors).length > 0) {
      // Block submit and surface the errors inline.
      setErrors(nextErrors);
      return;
    }

    setErrors(emptyFieldMap());
    await onResponse(action, buildElicitationContent(fields, values));
  };

  return (
    <Dialog open={!!elicitationRequest} onOpenChange={() => {}}>
      <DialogContent
        data-plugin-form-request-id={requestId}
        className="flex max-h-[80dvh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader className="min-w-0 shrink-0">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
            <MessageSquare className="h-3 w-3 shrink-0" />
            <RequestingServer elicitationRequest={elicitationRequest} />
          </DialogTitle>
          <DialogDescription className="max-h-24 overflow-y-auto text-md font-bold [overflow-wrap:anywhere]">
            {elicitationRequest?.message}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 min-w-0 space-y-6 overflow-y-auto py-4">
          {pluginForm ? (
            pluginPlan ? (
              <PluginFormFields
                requestId={requestId ?? ""}
                plan={pluginPlan}
                values={values}
                errors={errors}
                disabled={loading || pluginPending || pluginAnswered}
                ports={pluginForm.ports}
                onChange={updateFieldValue}
              />
            ) : (
              <p role="alert" className="text-sm text-destructive">
                This form contains inputs that this runtime cannot support.
                Cancel or decline to continue.
              </p>
            )
          ) : (
            fields.map((field) => {
              const label = fieldLabel(field);
              const showRawKey = Boolean(
                field.title && field.title !== field.name,
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
                            className="w-1.5 h-1.5 bg-destructive rounded-full"
                            title="Required field"
                          />
                        )}
                      </div>
                      {field.description && (
                        <p className="text-xs text-muted-foreground">
                          {field.description}
                        </p>
                      )}
                      {/* The pattern is shown, never executed — see the note on
                        `patternHint`. Plain text: it is server-supplied. */}
                      {patternHint(field) && (
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {patternHint(field)}
                        </p>
                      )}
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      {field.kind}
                    </Badge>
                  </div>
                  {
                    <SchemaFormFieldControl
                      field={field}
                      id={`elicitation-field-${field.name}`}
                      value={values[field.name]}
                      error={error}
                      disabled={loading}
                      onChange={(value) => updateFieldValue(field.name, value)}
                    />
                  }
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
            })
          )}
          {pluginForm && pluginError && (
            <p role="alert" className="text-sm text-destructive">
              {pluginError}
            </p>
          )}
        </div>

        {pluginForm?.presentation}
        <DialogFooter className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={() => handleResponse("cancel")}
            disabled={loading || pluginPending || pluginAnswered}
          >
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => handleResponse("decline")}
            disabled={loading || pluginPending || pluginAnswered}
          >
            Decline
          </Button>
          <Button
            onClick={() => handleResponse("accept")}
            disabled={
              loading ||
              pluginPending ||
              pluginAnswered ||
              (!!pluginForm && !pluginPlan)
            }
          >
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
 * Names remain plain text. Use the stable local identifier only as a fallback
 * when no display name was supplied; do not expose a duplicate technical label.
 */
function RequestingServer({
  elicitationRequest,
}: {
  elicitationRequest: DialogElicitation | null;
}) {
  const { serverId, serverName, origin } = elicitationRequest ?? {};
  const displayName = serverName?.trim() || serverId;

  // Era-honest phrasing: a modern MRTR (`input_required`) request means the
  // OPERATION needs input to continue, whereas a legacy `elicitation/create`
  // is an unsolicited question. Same dialog, truthful framing.
  const verb =
    origin === "mrtr" ? "needs input to continue" : "is requesting information";

  if (!displayName) {
    return (
      <>{origin === "mrtr" ? "Operation Needs Input" : "Elicitation Request"}</>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <strong className="font-semibold">{displayName}</strong>
      <span className="font-normal">{verb}</span>
    </span>
  );
}
