import { useEffect, useRef, useState } from "react";
import {
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import type {
  EventDescriptorView,
  EventsDeliveryModeView,
} from "@/shared/events-api";

export interface SubscribeFormValue {
  arguments: Record<string, unknown>;
  mode: EventsDeliveryModeView;
  maxAgeMs?: number;
  /** `null` asks for no expiry; absent leaves it to the server. */
  ttlMs?: number | null;
  /** Local webhook only: the user acknowledged the development receiver. */
  insecureLocalReceiver?: boolean;
}

export interface SubscribeForm {
  fields: FormField[];
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
  /** Raw JSON arguments instead of the generated form. */
  rawMode: boolean;
  toggleRawMode: () => void;
  rawJson: string;
  setRawJson: (value: string) => void;
  mode: EventsDeliveryModeView | null;
  setMode: (mode: EventsDeliveryModeView) => void;
  /** A local webhook needs the development-receiver acknowledgement. */
  needsAcknowledgement: boolean;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  maxAgeMs: string;
  setMaxAgeMs: (value: string) => void;
  ttlMs: string;
  setTtlMs: (value: string) => void;
  noExpiry: boolean;
  setNoExpiry: (value: boolean) => void;
  formError: string | null;
  canSubmit: boolean;
  submit: () => void;
}

function parseOptionalMs(
  raw: string,
  label: string,
): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return { error: `${label} must be a whole number of milliseconds.` };
  }
  return { value };
}

/**
 * The subscribe form's state, validation and submission, for one event type.
 * Arguments come from its `inputSchema` as a generated form (raw JSON when the
 * schema has no describable properties). The mode is limited to `modes`,
 * where the client, the event type and the runtime all agree; with none, or
 * with a `blockedReason`, nothing can be submitted.
 *
 * The header's Subscribe button and the form sections share this one
 * controller, so validation lives in one place.
 */
export function useSubscribeForm({
  event,
  modes,
  blockedReason,
  hosted,
  busy,
  onSubscribe,
}: {
  event: EventDescriptorView | undefined;
  modes: EventsDeliveryModeView[];
  blockedReason: string | null;
  hosted: boolean;
  busy: boolean;
  onSubscribe: (value: SubscribeFormValue) => void | Promise<void>;
}): SubscribeForm {
  const [fields, setFields] = useState<FormField[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState("{}");
  const [mode, setMode] = useState<EventsDeliveryModeView | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [maxAgeMs, setMaxAgeMs] = useState("");
  const [ttlMs, setTtlMs] = useState("");
  const [noExpiry, setNoExpiry] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // A second click lands before `busy` re-renders; this keeps it to one call.
  const submitting = useRef(false);

  // Keyed on the event's identity alone, so a catalog refresh does not wipe
  // what the user typed: the schema is read through a ref.
  const inputSchemaRef = useRef(event?.inputSchema);
  inputSchemaRef.current = event?.inputSchema;
  const eventName = event?.name;
  useEffect(() => {
    const next = generateFormFieldsFromSchema(inputSchemaRef.current);
    setFields(next);
    setRawMode(next.length === 0);
    setRawJson("{}");
    setAcknowledged(false);
    setMaxAgeMs("");
    setTtlMs("");
    setNoExpiry(false);
    setFormError(null);
  }, [eventName]);

  useEffect(() => {
    if (mode === null || !modes.includes(mode)) setMode(modes[0] ?? null);
  }, [modes, mode]);

  const needsAcknowledgement = !hosted && mode === "webhook";
  const canSubmit =
    event !== undefined &&
    mode !== null &&
    modes.includes(mode) &&
    blockedReason === null &&
    !busy &&
    (!needsAcknowledgement || acknowledged);

  const onFieldChange = (name: string, value: unknown) => {
    setFields((previous) =>
      previous.map((field) =>
        field.name === name ? { ...field, value, isSet: true } : field,
      ),
    );
  };
  const onToggleField = (name: string, isSet: boolean) => {
    setFields((previous) =>
      previous.map((field) =>
        field.name === name ? { ...field, isSet } : field,
      ),
    );
  };

  const submit = () => {
    if (!canSubmit || mode === null || submitting.current) return;
    let args: Record<string, unknown>;
    if (rawMode) {
      try {
        const parsed = JSON.parse(rawJson || "{}");
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setFormError("Arguments must be a JSON object.");
          return;
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        setFormError(
          error instanceof Error
            ? error.message
            : "The arguments are not valid JSON. Check them and try again.",
        );
        return;
      }
    } else {
      args = buildParametersFromFields(fields);
    }
    const maxAge = parseOptionalMs(maxAgeMs, "maxAgeMs");
    if (maxAge.error) {
      setFormError(maxAge.error);
      return;
    }
    // `ttlMs` is a webhook subscription's lifetime; poll and push have none.
    const ttl =
      mode !== "webhook"
        ? {}
        : noExpiry
          ? { value: null }
          : parseOptionalMs(ttlMs, "ttlMs");
    if ("error" in ttl && ttl.error) {
      setFormError(ttl.error);
      return;
    }
    setFormError(null);
    submitting.current = true;
    void Promise.resolve(
      onSubscribe({
        arguments: args,
        mode,
        ...(maxAge.value !== undefined ? { maxAgeMs: maxAge.value } : {}),
        ...("value" in ttl && ttl.value !== undefined
          ? { ttlMs: ttl.value }
          : {}),
        ...(needsAcknowledgement ? { insecureLocalReceiver: true } : {}),
      }),
    ).finally(() => {
      submitting.current = false;
    });
  };

  return {
    fields,
    onFieldChange,
    onToggleField,
    rawMode,
    toggleRawMode: () => setRawMode((value) => !value),
    rawJson,
    setRawJson,
    mode,
    setMode,
    needsAcknowledgement,
    acknowledged,
    setAcknowledged,
    maxAgeMs,
    setMaxAgeMs,
    ttlMs,
    setTtlMs,
    noExpiry,
    setNoExpiry,
    formError,
    canSubmit,
    submit,
  };
}
