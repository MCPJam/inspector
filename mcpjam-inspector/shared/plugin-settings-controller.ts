import {
  PluginSettingsError,
  PluginSettingsRequestError,
  parsePluginSettingsDocument,
  parsePluginSettingsUpdate,
  parsePluginSettingsSet,
  validatePluginSettingValue,
  type PluginSettingsDocument,
  type PluginSettingsField,
  type PluginSettingsValues,
} from "./plugin-settings.js";

interface SettingsPorts {
  /** The binding adapter owns server authorization, approvals and invocation receipts. */
  read: (signal: AbortSignal) => Promise<unknown>;
  update: (
    args: { set: PluginSettingsValues },
    signal: AbortSignal,
  ) => Promise<unknown>;
}
export interface NativeSettingsSnapshot {
  document: PluginSettingsDocument;
  draft: Record<string, unknown>;
  errors: Record<string, string>;
  dirty: boolean;
  busy: "save" | "refresh" | null;
  error?: string;
  closed: boolean;
  invalidated: boolean;
  uncertain: boolean;
}

function editorValue(field: PluginSettingsField, value: unknown): unknown {
  if (
    (field.type === "number" || field.type === "integer") &&
    typeof value === "string"
  ) {
    const decimal = value.trim();
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(decimal)
      ? Number(decimal)
      : undefined;
  }
  return value;
}

/** Settings effects are independent of elicitation's accept/cancel lifetime. */
export class NativeSettingsController {
  private document: PluginSettingsDocument;
  private readonly edits = new Map<
    string,
    { value: unknown; revision: number }
  >();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot!: NativeSettingsSnapshot;
  private busy: NativeSettingsSnapshot["busy"] = null;
  private error: string | undefined;
  private closed = false;
  private invalidated = false;
  private uncertain = false;
  private active?: AbortController;
  private saving?: Promise<void>;

  constructor(input: unknown, private readonly ports: SettingsPorts) {
    this.document = parsePluginSettingsDocument(input);
    this.publish();
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  edit(name: string, value: unknown) {
    if (this.closed || this.invalidated)
      throw new PluginSettingsError("PLUGIN_SETTINGS_CLOSED");
    if (!this.document.fields.some((field) => field.name === name))
      throw new PluginSettingsError("PLUGIN_SETTINGS_UNKNOWN_FIELD");
    this.edits.set(name, {
      value: structuredClone(value),
      revision: ++this.revision,
    });
    this.error = undefined;
    this.publish();
  }

  save(): Promise<void> {
    if (this.saving) return this.saving;
    if (this.closed || this.invalidated)
      return Promise.reject(new PluginSettingsError("PLUGIN_SETTINGS_CLOSED"));
    if (this.uncertain)
      return Promise.reject(
        new PluginSettingsError("PLUGIN_SETTINGS_REFRESH_REQUIRED"),
      );
    if (this.busy)
      return Promise.reject(new PluginSettingsError("PLUGIN_SETTINGS_BUSY"));
    const controller = new AbortController();
    this.active = controller;
    this.busy = "save";
    this.error = undefined;
    this.publish();
    // Publish the shared promise before running any injected effect.
    let dispatched = false;
    this.saving = Promise.resolve()
      .then(async () => {
        for (;;) {
          controller.signal.throwIfAborted();
          const { set, errors } = this.diff();
          if (Object.keys(errors).length)
            throw new PluginSettingsError("PLUGIN_SETTINGS_INVALID_EDIT");
          if (!Object.keys(set).length) return;
          const revisions = new Map(
            [...this.edits].map(([name, edit]) => [name, edit.revision]),
          );
          const request = parsePluginSettingsSet(this.document.fields, { set });
          dispatched = true;
          const result = await this.ports.update(request, controller.signal);
          controller.signal.throwIfAborted();
          if (this.closed)
            throw new PluginSettingsError("PLUGIN_SETTINGS_CLOSED");
          // Validate all effective values before committing any part of the baseline.
          const values = parsePluginSettingsUpdate(
            this.document.fields,
            result,
          );
          dispatched = false;
          this.document = { ...this.document, values };
          for (const name of Object.keys(set)) {
            if (this.edits.get(name)?.revision === revisions.get(name))
              this.edits.delete(name);
          }
          this.publish();
          // New edits coalesce into the next diff against the server's effective values.
        }
      })
      .catch((error) => {
        if (
          dispatched &&
          !(
            error instanceof PluginSettingsRequestError && !error.outcomeUnknown
          )
        )
          this.uncertain = true;
        if (!this.closed)
          this.error =
            error instanceof PluginSettingsError
              ? error.code
              : "PLUGIN_SETTINGS_SAVE_FAILED";
        // No automatic retry: a transport failure may have persisted the write.
        throw error;
      })
      .finally(() => {
        this.saving = undefined;
        this.active = undefined;
        this.busy = null;
        if (!this.closed) this.publish();
      });
    return this.saving;
  }

  async refresh(signal?: AbortSignal) {
    if (this.closed || this.invalidated)
      throw new PluginSettingsError("PLUGIN_SETTINGS_CLOSED");
    if (this.busy) throw new PluginSettingsError("PLUGIN_SETTINGS_BUSY");
    const controller = new AbortController();
    const operation = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    this.active = controller;
    this.busy = "refresh";
    this.error = undefined;
    this.publish();
    try {
      const input = await this.ports.read(operation);
      operation.throwIfAborted();
      if (this.closed) throw new PluginSettingsError("PLUGIN_SETTINGS_CLOSED");
      const document = parsePluginSettingsDocument(input);
      if (
        JSON.stringify(document.fields) !== JSON.stringify(this.document.fields)
      ) {
        this.invalidated = true;
        throw new PluginSettingsError("PLUGIN_SETTINGS_SCHEMA_CHANGED");
      }
      this.document = document;
      this.uncertain = false;
      // Retain every unsaved edit, including those made while this read was waiting.
    } catch (error) {
      if (!this.closed)
        this.error =
          error instanceof PluginSettingsError
            ? error.code
            : "PLUGIN_SETTINGS_REFRESH_FAILED";
      throw error;
    } finally {
      this.active = undefined;
      this.busy = null;
      if (!this.closed) this.publish();
    }
  }

  close() {
    this.closed = true;
    this.active?.abort();
    this.busy = null;
    this.publish();
    this.listeners.clear();
  }

  /** A settings action may change values even when its result was delivered. */
  requireRefresh() {
    if (this.closed) return;
    this.uncertain = true;
    this.error = "PLUGIN_SETTINGS_ACTION_REFRESH_REQUIRED";
    this.publish();
  }

  private diff() {
    const set: PluginSettingsValues = Object.create(null);
    const errors: Record<string, string> = Object.create(null);
    for (const field of this.document.fields) {
      const edit = this.edits.get(field.name);
      if (!edit) continue;
      const value = editorValue(field, edit.value);
      const error = validatePluginSettingValue(field, value);
      if (error) errors[field.name] = error;
      else if (value !== this.document.values[field.name])
        set[field.name] = value as PluginSettingsValues[string];
    }
    return { set, errors };
  }

  private publish() {
    const draft: Record<string, unknown> = Object.assign(
      Object.create(null),
      this.document.values,
    );
    for (const [name, edit] of this.edits)
      draft[name] = structuredClone(edit.value);
    const { set, errors } = this.diff();
    this.snapshot = {
      document: structuredClone(this.document),
      draft,
      errors,
      dirty: Object.keys(set).length > 0 || Object.keys(errors).length > 0,
      busy: this.busy,
      error: this.error,
      closed: this.closed,
      invalidated: this.invalidated,
      uncertain: this.uncertain,
    };
    for (const listener of this.listeners) listener();
  }
}
