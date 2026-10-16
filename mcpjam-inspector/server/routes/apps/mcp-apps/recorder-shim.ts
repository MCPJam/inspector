/// <reference lib="dom" />
// DOM types are for authoring only — these functions are serialized
// (`Function.toString()`) and run in the browser guest, never in Node.
/**
 * Tier 2 recorder — guest-injected click/type recorder for "Widget interaction
 * checks". The widget renders in a cross-origin sandboxed iframe, so the host
 * can't read the guest DOM; instead the sandbox proxy injects this shim INTO the
 * guest (when `recordMode` is on). The shim captures clicks/typing, builds an
 * `ElementLocator` bundle, and posts `recorder:step` out to the proxy, which
 * relays it to the host.
 *
 * `generateLocator` / `eventToStep` are written as **real testable functions**
 * (unit-tested in jsdom, round-tripped against the harness's
 * `resolveScriptedLocator` priority). `RECORDER_SHIM_JS` is their serialized
 * source (`Function.toString()`) wrapped in an IIFE — so the injected shim and
 * the tested code never drift. The functions MUST stay self-contained (no
 * module-scope refs; only each other + DOM globals) for serialization to work.
 */
import { RECORDER_CAPTURE_JS } from "./recorder-capture";
import type {
  ElementLocator,
  ScriptedStep,
  StepAssertion,
} from "@/shared/scripted-steps";

/** Result of replaying one scripted step in the guest. Mirrors the harness's
 *  `ScriptedStepResult` (ok + reason), minus the screenshot/tool-call fields the
 *  headless run captures. `deferred` flags a step the shim can't judge alone
 *  (`widgetToolCalled`) so the host evaluates it against its own tool-call log. */
export interface ReplayStepResult {
  ok: boolean;
  reason?: string;
  deferred?: "widgetToolCalled";
}

/** Prefer test IDs, then unique structural CSS. Accessible names are resolved by
 * Playwright at run time; a second implementation in the guest would disagree. */
export function generateLocator(el: Element): ElementLocator {
  const esc = (value: string): string =>
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  const testId = el.getAttribute("data-testid");
  if (testId) {
    const matches = Array.from(
      el.ownerDocument.querySelectorAll(`[data-testid="${esc(testId)}"]`),
    );
    return {
      testId,
      ...(matches.length > 1 ? { nth: matches.indexOf(el) } : {}),
    };
  }
  const parts: string[] = [];
  let current: Element | null = el;
  while (current) {
    if (
      current.id &&
      el.ownerDocument.querySelectorAll(`#${esc(current.id)}`).length === 1
    ) {
      parts.unshift(`#${esc(current.id)}`);
      break;
    }
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (node) => node.tagName === current!.tagName,
        )
      : [current];
    parts.unshift(
      `${esc(current.localName)}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`,
    );
    current = current.parentElement;
  }
  return { css: parts.join(" > ") };
}

/** Map a DOM event to a scripted step, or null if it's not a recordable action. */
export function eventToStep(event: Event): ScriptedStep | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  if (event.type === "click" || event.type === "contextmenu") {
    return {
      kind: "click",
      target: generateLocator(target),
      ...(event.type === "contextmenu" ? { clickType: "right" } : {}),
    };
  }
  if (event.type !== "input" && event.type !== "change") return null;
  if (target instanceof HTMLSelectElement)
    return {
      kind: "select",
      target: generateLocator(target),
      values: Array.from(target.selectedOptions, (option) => option.value),
    };
  if (
    target instanceof HTMLInputElement &&
    [
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "file",
      "range",
      "color",
      "hidden",
    ].includes(target.type)
  )
    return null;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  )
    return {
      kind: "type",
      target: generateLocator(target),
      text: target.value,
    };
  if (target instanceof HTMLElement && target.isContentEditable)
    return {
      kind: "type",
      target: generateLocator(target),
      text: target.textContent ?? "",
    };
  return null;
}

/**
 * Resolve an `ElementLocator` back to a live element in the guest — the inverse
 * of `generateLocator`. Priority MUST mirror the harness's
 * `resolveScriptedLocator` (testId → role+name → text → css) and the recorder's
 * own `generateLocator`, so a locator recorded in the browser, replayed in the
 * browser, and run in the headless harness all resolve to the same element.
 * Self-contained (helpers inlined) for `.toString()` serialization.
 */
export function resolveLocator(locator: ElementLocator): Element | null {
  const doc = document;
  const norm = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim();
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(s)
      : s.replace(/["\\\]]/g, "\\$&");
  const pick = (list: Element[]): Element | null => {
    if (list.length === 0) return null;
    const n = locator.nth;
    if (n !== undefined) return list[n] ?? null;
    return list[0];
  };

  // 1) testId
  if (locator.testId) {
    const matches = Array.prototype.slice.call(
      doc.querySelectorAll(`[data-testid="${esc(locator.testId)}"]`)
    ) as Element[];
    return pick(matches);
  }

  // 2) role + accessible name (mirrors generateLocator's role derivation)
  if (locator.role) {
    const implicitRole = (node: Element): string | undefined => {
      const tag = node.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && node.hasAttribute("href")) return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const t = (node.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "button" || t === "submit" || t === "reset") return "button";
        if (["text", "search", "email", "url", "tel", "password"].includes(t))
          return "textbox";
      }
      return undefined;
    };
    const accessibleName = (node: Element): string => {
      const aria = norm(node.getAttribute("aria-label"));
      if (aria) return aria;
      const labelledby = node.getAttribute("aria-labelledby");
      if (labelledby) {
        const parts = labelledby
          .split(/\s+/)
          .map((id) => norm(doc.getElementById(id)?.textContent))
          .filter(Boolean);
        if (parts.length) return parts.join(" ");
      }
      return norm(node.textContent);
    };
    const wantRole = locator.role.role;
    const wantName = locator.role.name;
    const exact = locator.role.exact === true;
    const matches = (
      Array.prototype.slice.call(doc.querySelectorAll("*")) as Element[]
    ).filter((el) => {
      const role = el.getAttribute("role") || implicitRole(el);
      if (role !== wantRole) return false;
      if (wantName === undefined) return true;
      const name = accessibleName(el);
      return exact
        ? name === wantName
        : name.toLowerCase().includes(wantName.toLowerCase());
    });
    return pick(matches);
  }

  // 3) visible text (getByText: substring, whitespace-normalized; prefer the
  // smallest matching element so we click the leaf, not a wrapping container).
  if (locator.text) {
    const want = norm(locator.text).toLowerCase();
    const matches = (
      Array.prototype.slice.call(doc.querySelectorAll("*")) as Element[]
    )
      .filter((el) => norm(el.textContent).toLowerCase().includes(want))
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length
      );
    return pick(matches);
  }

  // 4) css
  if (locator.css) {
    const matches = Array.prototype.slice.call(
      doc.querySelectorAll(locator.css)
    ) as Element[];
    return pick(matches);
  }

  return null;
}

/**
 * Replay one scripted step against the live guest widget — the browser analog of
 * the harness's `runScriptedStep`. Action steps drive the widget with real DOM
 * events (so the user watches them); `assert` steps evaluate against the DOM.
 * `widgetToolCalled` is deferred to the host (the shim can't see tool calls).
 * Async so `wait` and post-action settling work. Self-contained for serialization.
 */
function replayKeyboardDefault(target: Element, init: KeyboardEventInit): void {
  if (init.ctrlKey || init.metaKey || init.altKey) return;
  if (init.key === "Tab") {
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')).filter(node => node.tabIndex >= 0 && !node.matches(":disabled") && node.checkVisibility?.() !== false);
    const index = controls.indexOf(target as HTMLElement);
    const next = controls[(index + (init.shiftKey ? -1 : 1) + controls.length) % controls.length];
    next?.focus();
  } else if ((init.key === "Enter" && target.matches("button,a[href],input[type=submit],input[type=button]")) || (init.key === " " && target.matches("button,input[type=checkbox],input[type=radio]"))) {
    if (target instanceof HTMLElement) target.click();
  } else if (init.key === "Enter" && target instanceof HTMLInputElement) {
    target.form?.requestSubmit();
  }
}

export async function runReplayStep(
  step: ScriptedStep
): Promise<ReplayStepResult> {
  const norm = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim();
  // Style/connectedness-based visibility — correct in both real browsers and
  // jsdom (which has no layout engine, so rect-based checks can't be used).
  // Catches display:none / visibility:hidden / opacity:0 / detached; Playwright's
  // headless check is stricter on size/occlusion, so rare edge cases may differ.
  const isVisible = (el: Element | null): boolean => {
    if (!el || !el.isConnected) return false;
    const view = el.ownerDocument.defaultView;
    const style = view ? view.getComputedStyle(el) : null;
    if (!style) return true;
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };
  const fire = (el: Element, type: string, init?: MouseEventInit): void => {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        ...(init || {}),
      })
    );
  };
  const setNativeValue = (
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string
  ): void => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  };

  const evaluateAssertion = (assertion: StepAssertion): ReplayStepResult => {
    if (assertion.type === "widgetToolCalled") {
      return { ok: true, deferred: "widgetToolCalled" };
    }
    if (assertion.type === "textVisible") {
      const want = norm(assertion.text).toLowerCase();
      const hit = (
        Array.prototype.slice.call(document.querySelectorAll("*")) as Element[]
      ).find(
        (el) =>
          norm(el.textContent).toLowerCase().includes(want) && isVisible(el)
      );
      return hit
        ? { ok: true }
        : { ok: false, reason: `text not visible: "${assertion.text}"` };
    }
    if (assertion.type === "elementVisible") {
      const el = resolveLocator(assertion.target);
      return isVisible(el)
        ? { ok: true }
        : { ok: false, reason: "element not visible" };
    }
    if (assertion.type === "elementHidden") {
      const el = resolveLocator(assertion.target);
      return el && isVisible(el)
        ? { ok: false, reason: "element is visible (expected hidden)" }
        : { ok: true };
    }
    // inputValue
    const el = resolveLocator(assertion.target) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!el) return { ok: false, reason: "input not found" };
    return el.value === assertion.equals
      ? { ok: true }
      : {
          ok: false,
          reason: `input value "${el.value}" ≠ "${assertion.equals}"`,
        };
  };

  try {
    switch (step.kind) {
      case "click": {
        const el = resolveLocator(step.target);
        if (!el) return { ok: false, reason: "element not found" };
        if (typeof (el as HTMLElement).scrollIntoView === "function")
          (el as HTMLElement).scrollIntoView({
            block: "center",
          } as ScrollIntoViewOptions);
        if (step.clickType === "double") {
          if (el instanceof HTMLElement) { el.click(); el.click(); }
          fire(el, "dblclick", { detail: 2 });
        } else if (step.clickType === "right") {
          fire(el, "contextmenu", { button: 2 });
        } else if (typeof (el as HTMLElement).click === "function") {
          (el as HTMLElement).click();
        } else {
          fire(el, "click");
        }
        return { ok: true };
      }
      case "type": {
        const el = resolveLocator(step.target);
        if (!el) return { ok: false, reason: "input not found" };
        if (typeof (el as HTMLElement).focus === "function")
          (el as HTMLElement).focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) setNativeValue(el, step.text);
        else el.textContent = step.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      case "key": {
        const target = step.target ? resolveLocator(step.target) : document.activeElement ?? document.body;
        if (!target) return { ok: false, reason: "key target not found" };
        if (target instanceof HTMLElement) target.focus();
        const parts = step.key.split("+");
        const key = parts.pop()!;
        const init = { key: key === "Space" ? " " : key === "Equal" ? (parts.includes("Shift") ? "+" : "=") : key === "NumpadAdd" ? "+" : key, ctrlKey: parts.includes("Control"), metaKey: parts.includes("Meta"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift"), bubbles: true, cancelable: true };
        const accepted = target.dispatchEvent(
          new KeyboardEvent("keydown", init)
        );
        if (accepted) replayKeyboardDefault(target, init);
        target.dispatchEvent(
          new KeyboardEvent("keyup", init)
        );
        return { ok: true };
      }
      case "select": {
        const target = resolveLocator(step.target);
        if (!(target instanceof HTMLSelectElement)) return { ok: false, reason: "select not found" };
        if (step.values.some(value => !Array.from(target.options).some(option => option.value === value))) return { ok: false, reason: "option not found" };
        for (const option of Array.from(target.options)) option.selected = step.values.includes(option.value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      case "scrollTo": {
        const target = resolveLocator(step.target);
        if (!target) return { ok: false, reason: "scroll target not found" };
        const scroller = target === document.documentElement || target === document.scrollingElement ? window : target;
        scroller.scrollTo({ left: step.x, top: step.y, behavior: "instant" });
        return { ok: true };
      }
      case "scroll": {
        const amount = (step.amount ?? 3) * 100;
        window.scrollBy(0, step.direction === "up" ? -amount : amount);
        return { ok: true };
      }
      case "wait": {
        await new Promise((resolve) => window.setTimeout(resolve, step.ms));
        return { ok: true };
      }
      case "assert":
        return evaluateAssertion(step.assertion);
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: false, reason: "unknown step" };
}

/**
 * The shim source injected into the guest `srcdoc` (an IIFE). Serializes the
 * capture (`generateLocator`/`eventToStep`) AND replay
 * (`resolveLocator`/`runReplayStep`) functions so the injected code is exactly
 * what the tests exercise. Order matters: callees before `installRecorder`,
 * which references them by name from the shared IIFE scope.
 */
export const RECORDER_SHIM_JS: string = [
  "(function(){",
  // esbuild/tsx may emit calls to its `__name` helper inside
  // Function.toString() output. The helper exists in the server module scope,
  // but not in the browser guest iframe where this IIFE runs.
  "var __name = function(target) { return target; };",
  generateLocator.toString(),
  eventToStep.toString(),
  resolveLocator.toString(),
  replayKeyboardDefault.toString(),
  runReplayStep.toString(),
  RECORDER_CAPTURE_JS,
  "installRecorder(generateLocator, eventToStep, runReplayStep);",
  "})();",
].join("\n");
