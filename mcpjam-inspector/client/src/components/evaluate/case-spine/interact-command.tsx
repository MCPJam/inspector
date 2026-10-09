import { useId, useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import type { InteractAction } from "@/shared/steps";
import { useInvalidDraftRegistration } from "@/components/evals/checks-section";

function targetText(
  action: Extract<InteractAction, { kind: "click" | "type" }>,
): string {
  return (
    action.target.text ??
    action.target.role?.name ??
    action.target.testId ??
    action.target.css ??
    action.target.role?.role ??
    ""
  );
}

/** A short command edits the existing action, without introducing a second runner format. */
export function interactionCommand(action: InteractAction): string {
  switch (action.kind) {
    case "click":
      return `Click ${targetText(action)}`.trimEnd();
    case "type":
      return `Type ${JSON.stringify(action.text)} into ${targetText(action)}`.trimEnd();
    case "key":
      return `Press ${action.key}`.trimEnd();
    case "scroll":
      return `Scroll ${action.direction}${action.amount == null ? "" : ` ${action.amount}`}`;
    case "wait":
      return `Wait ${action.ms} ms`;
  }
}

export function parseInteractionCommand(
  text: string,
  previous: InteractAction,
): InteractAction | null {
  const click = /^Click\s+(.+)$/i.exec(text.trim());
  if (click) {
    const target =
      previous.kind === "click" && click[1] === targetText(previous)
        ? previous.target
        : { text: click[1] };
    return previous.kind === "click"
      ? { ...previous, target }
      : { kind: "click", target };
  }
  const type = /^Type\s+("(?:[^"\\]|\\.)*")\s+into\s+(.+)$/i.exec(text.trim());
  if (type) {
    const target =
      previous.kind === "type" && type[2] === targetText(previous)
        ? previous.target
        : { text: type[2] };
    try {
      return { kind: "type", text: JSON.parse(type[1]), target };
    } catch {
      return null;
    }
  }
  const key = /^Press\s+(.+)$/i.exec(text.trim());
  if (key) return { kind: "key", key: key[1] };
  const scroll = /^Scroll\s+(up|down)(?:\s+(\d+))?$/i.exec(text.trim());
  if (
    scroll &&
    (!scroll[2] ||
      (Number.isSafeInteger(Number(scroll[2])) && Number(scroll[2]) > 0))
  )
    return {
      kind: "scroll",
      direction: scroll[1].toLowerCase() as "up" | "down",
      ...(scroll[2] ? { amount: Number(scroll[2]) } : {}),
    };
  const wait = /^Wait\s+(\d+)\s*ms$/i.exec(text.trim());
  if (wait && Number(wait[1]) > 0 && Number(wait[1]) <= 30000)
    return { kind: "wait", ms: Number(wait[1]) };
  return null;
}

export function InteractCommandField({
  action,
  onChange,
  readOnly,
}: {
  action: InteractAction;
  onChange: (action: InteractAction) => void;
  readOnly: boolean;
}) {
  const id = useId();
  const key = JSON.stringify(action);
  const [draft, setDraft] = useState(() => ({
    text: interactionCommand(action),
    forAction: key,
    touched: false,
  }));
  if (draft.forAction !== key)
    setDraft({
      text: interactionCommand(action),
      forAction: key,
      touched: false,
    });
  const current =
    draft.forAction === key
      ? draft
      : { text: interactionCommand(action), forAction: key, touched: false };
  const invalid =
    current.touched && parseInteractionCommand(current.text, action) === null;
  useInvalidDraftRegistration(invalid && !readOnly);
  return (
    <div className="space-y-1.5">
      <p id={`${id}-help`} className="text-[13px] leading-[18px] text-secondary-foreground dark:text-muted-foreground">
        Describe what should happen below. We support clicks, typing, keys,
        scrolls, and waits.
      </p>
      <Input
        aria-label="Interaction command"
        aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
        aria-invalid={invalid || undefined}
        readOnly={readOnly}
        placeholder="Click Generate diagram"
        className="h-9 text-sm"
        value={current.text === "Click" && !current.touched ? "" : current.text}
        onChange={(event) => {
          const text = event.target.value;
          const next = parseInteractionCommand(text, action);
          setDraft({
            text,
            forAction: next ? JSON.stringify(next) : key,
            touched: true,
          });
          if (next) onChange(next);
        }}
      />
      {invalid ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          Use Click [text], Type "text" into [text], Press [key], Scroll up/down
          [amount], or Wait [ms] ms. You can also use detailed settings.
        </p>
      ) : null}
    </div>
  );
}
