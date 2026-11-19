import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

function controls(root: HTMLDivElement, role: "radio" | "checkbox") {
  return [...root.querySelectorAll<HTMLButtonElement>(`button[role="${role}"]`)]
    .filter((button) => button.closest('[role="radiogroup"], [role="group"]') === root);
}

/** Custom choice buttons retain their click behavior and share radio keyboard semantics. */
export function FormChoiceGroup({
  multiple,
  label,
  className,
  children,
}: {
  multiple: boolean;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (multiple) {
      controls(root, "checkbox").forEach((button) => button.removeAttribute("tabindex"));
      return;
    }
    const radios = controls(root, "radio");
    const enabled = radios.filter((button) => !button.disabled);
    const entry = enabled.find((button) => button.getAttribute("aria-checked") === "true") ?? enabled[0];
    radios.forEach((button) => { button.tabIndex = button === entry ? 0 : -1; });
  }, [children, multiple]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (multiple || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!direction || !(event.target instanceof Element)) return;
    const root = event.currentTarget;
    const current = event.target.closest<HTMLButtonElement>('button[role="radio"]');
    const enabled = controls(root, "radio").filter((button) => !button.disabled);
    const index = current ? enabled.indexOf(current) : -1;
    if (index < 0) return;
    const next = enabled[(index + direction + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (next.getAttribute("aria-checked") !== "true") next.click();
  };

  return (
    <div ref={ref} role={multiple ? "group" : "radiogroup"} aria-label={label}
      className={className} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
