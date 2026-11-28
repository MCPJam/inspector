import { useRef, useState } from "react";
import {
  checkCallbackUrl,
  DEFAULT_LOCAL_WEBHOOK_TTL_MS,
  type ReceiverChoice,
} from "@mcpjam/sdk/browser";
import {
  httpsReceiverOf,
  useCallbackPreference,
} from "./use-callback-preference";
import { preferredDeliveryModes } from "@/shared/client-events";
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
  receiver?: ReceiverChoice;
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
  receiverKind: ReceiverChoice["kind"];
  setReceiverKind: (kind: ReceiverChoice["kind"]) => void;
  customCallbackUrl: string;
  setCustomCallbackUrl: (value: string) => void;
  callbackUrl?: string;
  callbackUrlError: string | null;
  /** HTTP callbacks need explicit consent for each subscription. */
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
 * with a `blockedReason`, nothing can be submitted. It defaults to the first of
 * them in `preferredDeliveryModes`' order, as the agent picks.
 *
 * The header's Subscribe button and the form sections share this one
 * controller, so validation lives in one place.
 */
export function useSubscribeForm({
  event,
  modes,
  blockedReason,
  hosted,
  serverSignedIn,
  projectId,
  serverId,
  busy,
  onSubscribe,
}: {
  event: EventDescriptorView | undefined;
  modes: EventsDeliveryModeView[];
  blockedReason: string | null;
  hosted: boolean;
  /** The server signs MCPJam in, so it may accept webhook (`serverHasSignIn`). */
  serverSignedIn: boolean;
  projectId?: string | null;
  serverId?: string;
  busy: boolean;
  onSubscribe: (value: SubscribeFormValue) => void | Promise<void>;
}): SubscribeForm {
  const [formFor, setFormFor] = useState<string | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState("{}");
  const [pickedMode, setMode] = useState<EventsDeliveryModeView | null>(null);
  const callback = useCallbackPreference(projectId, hosted ? undefined : serverId);
  const { draft, saved } = callback;
  const [acknowledged, setAcknowledged] = useState(false);
  const [maxAgeMs, setMaxAgeMs] = useState("");
  const [ttlMs, setTtlMs] = useState("");
  const [noExpiry, setNoExpiry] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // A second click lands before `busy` re-renders; this keeps it to one call.
  const submitting = useRef(false);

  // Keyed on the event's identity alone, so a catalog refresh does not wipe
  // what the user typed. Reset while rendering, not in an effect: React
  // re-renders before committing, so no frame shows an empty form ("No
  // parameters required") or the previous event type's fields.
  const formKey = JSON.stringify([
    event?.name ?? null,
    projectId ?? null,
    serverId ?? null,
  ]);
  if (formFor !== formKey) {
    const next = generateFormFieldsFromSchema(event?.inputSchema);
    setFormFor(formKey);
    setFields(next);
    setRawMode(next.length === 0);
    setRawJson("{}");
    setAcknowledged(false);
    setMaxAgeMs("");
    setTtlMs("");
    setNoExpiry(false);
    setFormError(null);
  }

  // The user's pick while it is still allowed, else the preferred allowed
  // mode. Derived, so the first render already names a mode instead of none.
  // The saved receiver, not the draft, decides: editing the URL mustn't flip
  // the default out from under the field being edited.
  const mode =
    pickedMode !== null && modes.includes(pickedMode)
      ? pickedMode
      : (preferredDeliveryModes(modes, {
          runtime: hosted ? "hosted" : "local",
          serverSignedIn,
          httpsReceiver: !hosted && httpsReceiverOf(saved) !== undefined,
        })[0] ?? null);

  const localWebhook = !hosted && mode === "webhook";
  const custom = localWebhook && draft.kind === "custom";
  const checked = custom ? checkCallbackUrl(draft.url) : undefined;
  const receiver: ReceiverChoice | undefined = localWebhook
    ? custom
      ? checked?.ok ? { kind: "custom", baseUrl: checked.url.href } : undefined
      : { kind: "local" }
    : undefined;
  const needsAcknowledgement = localWebhook && (!custom || checked?.ok === true && checked.insecure);
  const canSubmit =
    event !== undefined &&
    mode !== null &&
    modes.includes(mode) &&
    blockedReason === null &&
    !busy &&
    (!localWebhook || receiver !== undefined) &&
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
    const effectiveTtl = "value" in ttl ? ttl.value : localWebhook ? DEFAULT_LOCAL_WEBHOOK_TTL_MS : undefined;
    if (receiver) callback.remember(receiver);
    setFormError(null);
    submitting.current = true;
    void Promise.resolve(
      onSubscribe({
        arguments: args,
        mode,
        ...(maxAge.value !== undefined ? { maxAgeMs: maxAge.value } : {}),
        ...(effectiveTtl !== undefined ? { ttlMs: effectiveTtl } : {}),
        ...(receiver ? { receiver } : {}),
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
    receiverKind: draft.kind,
    setReceiverKind: (kind) => {
      callback.setDraft({ ...draft, kind });
      const previous = checkCallbackUrl(draft.url);
      callback.remember(kind === "local"
        ? { kind }
        : { kind, baseUrl: previous.ok ? previous.url.href : "" });
      setAcknowledged(false);
    },
    customCallbackUrl: draft.url,
    setCustomCallbackUrl: (url) => {
      callback.setDraft({ ...draft, url });
      setAcknowledged(false);
    },
    callbackUrl: checked?.ok ? checked.url.href : undefined,
    callbackUrlError: draft.url.trim() && checked && !checked.ok ? checked.reason : null,
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
