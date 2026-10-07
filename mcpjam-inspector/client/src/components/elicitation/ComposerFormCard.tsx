import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { PluginDescribedError } from "@/shared/plugin-operation";
import {
  buildPluginFormContent,
  initialPluginFormValues,
  validatePluginFormContent,
  type PluginFormPlan,
} from "@/shared/plugin-extensions/form-plan";
import {
  PluginFormFields,
  type PluginFormPorts,
} from "../schema-form/PluginFormFields";
import { PluginServerIcon } from "../chat-v2/chat-input/plugin-server-icon";
import type { UnsupportedPluginForm } from "./form-diagnostics";
import {
  clearComposerFormDraft,
  readComposerFormDraft,
  writeComposerFormDraft,
} from "./composer-form-store";
import type { ServerIconSources } from "../host-workspace/plugin-icon-directory";

export type ComposerFormAction = "accept" | "decline" | "cancel";

/** Field names are server-chosen; maps keyed by them never inherit. */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Validator wording stays in Trace/Raw; the card speaks plainly. */
const PLAIN_ERRORS: Record<string, string> = {
  "Required field": "Answer this to continue.",
  "Does not match the required pattern":
    "This answer isn't in the expected format.",
  "Does not satisfy the requested field":
    "This answer doesn't fit what was asked.",
};
const plainError = (message: string) => PLAIN_ERRORS[message] ?? message;

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Shortcut() {
  return (
    <kbd
      aria-hidden="true"
      className="ml-1.5 rounded border border-current/20 px-1 font-sans text-[10px] leading-4 opacity-70"
    >
      {isMac ? "⌘↵" : "Ctrl ↵"}
    </kbd>
  );
}

/**
 * The card chrome shared by every form state: plugin icon, the request
 * message as the title, optional "n of m" paging, and × (cancel the request).
 */
export function ComposerFormFrame({
  title,
  serverName,
  icons,
  paging,
  onClose,
  closeDisabled,
  footer,
  onKeyDown,
  rootRef,
  requestId,
  children,
}: {
  title: string;
  serverName: string;
  /** The asking server's icons (its plugin's, when it belongs to one). */
  icons?: ServerIconSources;
  paging?: {
    step: number;
    total: number;
    previous?: () => void;
    next?: () => void;
  };
  onClose: () => void;
  closeDisabled?: boolean;
  footer?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  rootRef?: React.Ref<HTMLElement>;
  requestId?: string;
  children?: ReactNode;
}) {
  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-label={title || `${serverName} requests information`}
      data-composer-form={requestId}
      onKeyDown={onKeyDown}
      className="flex max-h-[min(70dvh,40rem)] w-full min-w-0 flex-col text-sm outline-none"
    >
      <header className="flex min-w-0 shrink-0 items-start gap-2 px-4 pb-2 pt-3">
        <PluginServerIcon
          serverName={serverName}
          pluginIcons={icons?.pluginIcons}
          serverIcons={icons?.serverIcons}
          className="mt-0.5"
        />
        <h2 className="line-clamp-2 min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
          <span className="sr-only">{serverName} requests information: </span>
          {title}
        </h2>
        {paging && paging.total > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Previous question"
              disabled={!paging.previous}
              onClick={paging.previous}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span aria-live="polite">
              {paging.step + 1} of {paging.total}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Next question"
              disabled={!paging.next}
              onClick={paging.next}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label="Close"
          disabled={closeDisabled}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-3">
        {children}
      </div>
      {footer && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
          {footer}
        </footer>
      )}
    </section>
  );
}

/**
 * Presentation for an extension form in the composer's place. The form plan
 * and the answer transport belong to the caller; this view only collects
 * values one question at a time.
 *
 * - **Skip for now** omits an optional field; required fields are never
 *   omitted, though an empty value is fine unless the field forbids it.
 * - **Decline** sends `decline`; **×** sends `cancel`.
 * - The last step's **Continue** sends `accept` with the values given.
 */
export function ComposerFormCard({
  requestId,
  title,
  serverName,
  icons,
  plan,
  unsupported,
  ports,
  presentation,
  loading = false,
  onRespond,
}: {
  requestId: string;
  title: string;
  serverName: string;
  icons?: ServerIconSources;
  plan?: PluginFormPlan;
  unsupported?: UnsupportedPluginForm;
  ports?: PluginFormPorts;
  presentation?: ReactNode;
  loading?: boolean;
  onRespond: (
    action: ComposerFormAction,
    content?: Record<string, unknown>,
  ) => Promise<void> | void;
}) {
  // A pending form stays with its chat: answers typed before switching away
  // come back with the card.
  const [schemaKey] = useState(() => (plan ? JSON.stringify(plan.schema) : ""));
  const [draft] = useState(() =>
    plan ? readComposerFormDraft(requestId, schemaKey) : undefined,
  );
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    draft
      ? Object.assign(emptyMap(), structuredClone(draft.values))
      : plan
        ? initialPluginFormValues(plan)
        : emptyMap(),
  );
  const [step, setStep] = useState(() =>
    Math.min(draft?.step ?? 0, Math.max(0, (plan?.fields.length ?? 1) - 1)),
  );
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(
    () => new Set(draft?.skipped ?? []),
  );
  const [errors, setErrors] = useState<Record<string, string>>(emptyMap);
  const [pending, setPending] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [failure, setFailure] = useState<string>();
  const responding = useRef(false);
  const mounted = useRef(true);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    mounted.current = true;
    // The card takes the composer's place, so it takes its focus too.
    root.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!plan || answered) return;
    writeComposerFormDraft(requestId, {
      schema: schemaKey,
      values,
      step,
      skipped: [...skipped],
    });
  }, [plan, answered, requestId, schemaKey, values, step, skipped]);

  const fields = plan?.fields ?? [];
  const total = fields.length;
  const current = fields[Math.min(step, Math.max(0, total - 1))];
  const last = step >= total - 1;
  const busy = loading || pending || answered;

  const respond = async (
    action: ComposerFormAction,
    content?: Record<string, unknown>,
  ) => {
    if (busy || responding.current) return;
    responding.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await onRespond(action, content);
      clearComposerFormDraft(requestId);
      if (mounted.current) setAnswered(true);
    } catch (error) {
      // The card keeps every answer and its step, so the same send can be
      // retried.
      if (mounted.current)
        setFailure(
          error instanceof PluginDescribedError
            ? error.message
            : "Your answer couldn't be sent. Try again.",
        );
    } finally {
      responding.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const check = (omit: ReadonlySet<string>) => {
    const content = buildPluginFormContent(plan!, values);
    for (const name of omit) delete content[name];
    const result = validatePluginFormContent(plan!, content);
    const plain = emptyMap<string>();
    for (const [name, message] of Object.entries(result.errors))
      plain[name] = plainError(message);
    return { content, result, plain };
  };

  const finish = (omit: ReadonlySet<string>) => {
    const { content, result, plain } = check(omit);
    if (!result.valid) {
      setErrors(plain);
      const first = fields.findIndex(({ name }) => name in plain);
      if (first >= 0) setStep(first);
      setFailure(
        first < 0 ? "These answers don't fit what was asked." : undefined,
      );
      return;
    }
    setErrors(emptyMap());
    void respond("accept", content);
  };

  const advance = (omit: ReadonlySet<string>) => {
    if (!plan || busy) return;
    if (last || !current) return finish(omit);
    if (!omit.has(current.name)) {
      const { plain } = check(omit);
      if (plain[current.name]) {
        setErrors(
          Object.assign(emptyMap<string>(), {
            [current.name]: plain[current.name],
          }),
        );
        return;
      }
    }
    setErrors(emptyMap());
    setStep(step + 1);
  };

  const skip = () => {
    if (!current || current.required) return;
    const next = new Set(skipped);
    next.add(current.name);
    setSkipped(next);
    advance(next);
  };

  const change = (name: string, value: unknown) => {
    // Object.assign onto a null-prototype base: names are server-chosen.
    setValues((old) => Object.assign(emptyMap(), old, { [name]: value }));
    setErrors((old) => {
      if (!(name in old)) return old;
      const next = Object.assign(emptyMap<string>(), old);
      delete next[name];
      return next;
    });
    setSkipped((old) => {
      if (!old.has(name)) return old;
      const next = new Set(old);
      next.delete(name);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (plan) advance(skipped);
      return;
    }
    const target = event.target as HTMLElement;
    const typing =
      target.isContentEditable ||
      (target.tagName === "INPUT" &&
        !["checkbox", "radio", "button"].includes(
          (target as HTMLInputElement).type,
        )) ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT";
    if (
      /^[1-9]$/.test(event.key) &&
      !typing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const choice = root.current?.querySelector<HTMLElement>(
        `[data-choice-key="${event.key}"]:not([disabled])`,
      );
      if (choice) {
        event.preventDefault();
        choice.click();
      }
    }
  };

  const cancel = () => void respond("cancel");
  const decline = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground"
      disabled={busy}
      onClick={() => void respond("decline")}
    >
      Decline
    </Button>
  );

  if (!plan)
    return (
      <ComposerFormFrame
        rootRef={root}
        requestId={requestId}
        title={title}
        serverName={serverName}
        icons={icons}
        onClose={cancel}
        closeDisabled={busy}
        footer={
          <>
            {decline}
            <span className="flex-1" />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7"
              disabled={busy}
              onClick={cancel}
            >
              Cancel request
            </Button>
          </>
        }
      >
        <div role="alert" className="space-y-1 text-muted-foreground">
          <p className="text-foreground">This form can&apos;t be shown here.</p>
          <p>
            {unsupported?.field ? (
              <>
                <span className="font-medium text-foreground">
                  {unsupported.field}
                </span>
                : {unsupported.reason}
              </>
            ) : (
              (unsupported?.reason ??
              "It uses an input this client doesn't support.")
            )}
          </p>
          {failure && <p className="text-destructive">{failure}</p>}
        </div>
      </ComposerFormFrame>
    );

  return (
    <ComposerFormFrame
      rootRef={root}
      requestId={requestId}
      title={title}
      serverName={serverName}
      icons={icons}
      onKeyDown={onKeyDown}
      onClose={cancel}
      closeDisabled={busy}
      paging={{
        step,
        total,
        previous: step > 0 && !busy ? () => setStep(step - 1) : undefined,
        next: !last && !busy ? () => advance(skipped) : undefined,
      }}
      footer={
        <>
          {decline}
          <span className="flex-1" />
          {current && !current.required && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              disabled={busy}
              onClick={skip}
            >
              Skip for now
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-full px-3"
            disabled={busy}
            onClick={() => advance(skipped)}
          >
            {last ? "Continue" : "Next"}
            <Shortcut />
          </Button>
        </>
      }
    >
      {current && (
        <div className={cn(skipped.has(current.name) && "opacity-70")}>
          <PluginFormFields
            requestId={requestId}
            plan={plan}
            only={current.name}
            values={values}
            errors={errors}
            disabled={busy}
            ports={ports}
            onChange={change}
          />
        </div>
      )}
      {presentation}
      {failure && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {failure}
        </p>
      )}
    </ComposerFormFrame>
  );
}
