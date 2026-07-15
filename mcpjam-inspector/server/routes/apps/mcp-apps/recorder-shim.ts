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

/**
 * Build an `ElementLocator` from a clicked element. Priority mirrors the
 * harness's `resolveScriptedLocator` (testId → role+name → text → css) so a
 * recorded locator resolves to the same element in the headless harness at run
 * time. Self-contained: all helpers are inlined for `.toString()` serialization.
 */
export function generateLocator(el: Element): ElementLocator {
  const text = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim();
  // CSS.escape is present in real browsers (the guest); fall back for older
  // jsdom in tests. Self-contained so it survives `.toString()` serialization.
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(s)
      : s.replace(/["\\\]]/g, "\\$&");

  // A candidate locator is only trustworthy if it re-selects THIS exact element.
  // `resolveLocator` mirrors the harness's `resolveScriptedLocator`, so a
  // candidate that round-trips here resolves identically in the headless run.
  // When a higher-priority candidate (role+name, text) is ambiguous — it lands
  // on a sibling or a descendant (e.g. `text="🛒"` resolving to the wrong glyph)
  // — we skip it and fall through to the CSS path, which is built to be unique.
  // This is the general invariant that keeps record == replay, with no "is this
  // element interactive?" guessing. See the draft note for open refinements.
  const roundTripsTo = (candidate: ElementLocator): boolean => {
    try {
      return resolveLocator(candidate) === el;
    } catch {
      return false;
    }
  };

  // 1) testId — most stable.
  const testId = el.getAttribute("data-testid");
  if (testId) {
    const matches = el.ownerDocument.querySelectorAll(
      `[data-testid="${esc(testId)}"]`
    );
    const loc: ElementLocator = { testId };
    if (matches.length > 1) loc.nth = Array.prototype.indexOf.call(matches, el);
    return loc;
  }

  // 2) ARIA role (explicit or implicit) + accessible name.
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
    const aria = text(node.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledby = node.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => text(node.ownerDocument.getElementById(id)?.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    return text(node.textContent);
  };
  const role = el.getAttribute("role") || implicitRole(el);
  if (role) {
    const name = accessibleName(el);
    const candidate: ElementLocator = {
      role: { role, ...(name ? { name } : {}) },
    };
    // Only accept role+name when it uniquely re-selects this element. A
    // container whose name resolves to a child, or a duplicate-named sibling,
    // falls through.
    if (roundTripsTo(candidate)) return candidate;
  }

  // 3) Visible text — accepted only when it round-trips to this exact element
  // (ambiguous/duplicate text falls through to the unique CSS path).
  const visible = text(el.textContent);
  if (visible && visible.length <= 80) {
    const candidate: ElementLocator = { text: visible };
    if (roundTripsTo(candidate)) return candidate;
  }

  // 4) CSS path fallback (id → nth-of-type chain), with nth if non-unique.
  const cssPath = (node: Element): string => {
    if (node.id) return `#${esc(node.id)}`;
    const parts: string[] = [];
    let cur: Element | null = node;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let sel = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.tagName === cur!.tagName
        );
        if (sameTag.length > 1) {
          sel += `:nth-of-type(${
            Array.prototype.indexOf.call(sameTag, cur) + 1
          })`;
        }
      }
      parts.unshift(sel);
      if (cur.id) break;
      cur = parent;
    }
    return parts.join(" > ");
  };
  const css = cssPath(el);
  const cssMatches = el.ownerDocument.querySelectorAll(css);
  const loc: ElementLocator = { css };
  if (cssMatches.length > 1)
    loc.nth = Array.prototype.indexOf.call(cssMatches, el);
  return loc;
}

/** Map a DOM event to a scripted step, or null if it's not a recordable action. */
export function eventToStep(event: Event): ScriptedStep | null {
  const target = event.target as Element | null;
  if (!target || target.nodeType !== 1) return null;
  if (event.type === "click") {
    return { kind: "click", target: generateLocator(target) };
  }
  if (event.type === "change") {
    const t = target as HTMLInputElement | HTMLTextAreaElement;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      return { kind: "type", target: generateLocator(target), text: t.value };
    }
  }
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
        const el = resolveLocator(step.target) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        if (!el) return { ok: false, reason: "input not found" };
        if (typeof (el as HTMLElement).focus === "function")
          (el as HTMLElement).focus();
        setNativeValue(el, step.text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      case "key": {
        const target =
          (document.activeElement as Element | null) ?? document.body;
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: step.key, bubbles: true })
        );
        target.dispatchEvent(
          new KeyboardEvent("keyup", { key: step.key, bubbles: true })
        );
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
 * Guest bootstrap: attach capture-phase listeners and post recorded steps to the
 * proxy (`window.parent`). Posts `recorder:ready` on install and keeps a quiet
 * heartbeat while active so the host can detect a strict-CSP guest that silently
 * blocked the shim without depending on one perfectly timed postMessage. Written
 * as a string factory referencing the two functions by name (they're serialized
 * alongside).
 */
function recorderBootstrap(): void {
  // These names are resolved from the serialized IIFE scope (see RECORDER_SHIM_JS).
  const toStep = eventToStep;
  const replayStep = runReplayStep;
  const debug = (message: string, details?: unknown) => {
    try {
      if (window.localStorage?.getItem("mcpjam:recorder-debug") === "1") {
        console.info("[recorder:guest] " + message, details ?? {});
      }
    } catch {
      /* debug logging is best-effort */
    }
  };
  const post = (data: unknown) => {
    try {
      window.parent.postMessage(data, "*");
    } catch {
      /* cross-origin post is best-effort */
    }
  };
  const handler = (event: Event) => {
    const step = toStep(event);
    if (step) {
      debug("step", {
        type: event.type,
        tagName: (event.target as Element | null)?.tagName ?? null,
      });
      post({ type: "recorder:step", step });
    }
  };
  const announceReady = () => {
    debug("ready");
    post({ type: "recorder:ready" });
  };

  // Host → guest replay: the host posts `recorder:replay-step` (one step at a
  // time, with a correlation `id`); the shim drives the live widget and posts
  // `recorder:replay-result` back. This is the inverse of the capture path and
  // the same channel the proxy already relays both ways.
  const onReplayMessage = (event: MessageEvent) => {
    const data = event.data as {
      type?: string;
      id?: unknown;
      step?: unknown;
    } | null;
    if (!data || data.type !== "recorder:replay-step") return;
    const id = data.id;
    debug("replay-step", { id });
    Promise.resolve(replayStep(data.step as never))
      .then((result) => {
        post({ type: "recorder:replay-result", id, ...result });
      })
      .catch((err: unknown) => {
        post({
          type: "recorder:replay-result",
          id,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  };
  window.addEventListener("message", onReplayMessage);

  debug("bootstrap");
  document.addEventListener("click", handler, true);
  document.addEventListener("change", handler, true);

  // `srcdoc` navigations can replace the inner iframe while the first ready ping
  // is in flight. Ready is idempotent on the host, so repeat it across the short
  // boot window instead of treating one dropped postMessage as recorder failure.
  announceReady();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady, {
      once: true,
    });
  }
  window.addEventListener("load", announceReady, { once: true });
  [50, 250, 1000, 2500].forEach((delay) => {
    window.setTimeout(announceReady, delay);
  });
  const heartbeat = window.setInterval(announceReady, 2000);
  window.addEventListener("pagehide", () => window.clearInterval(heartbeat), {
    once: true,
  });
}

/**
 * The shim source injected into the guest `srcdoc` (an IIFE). Serializes the
 * capture (`generateLocator`/`eventToStep`) AND replay
 * (`resolveLocator`/`runReplayStep`) functions so the injected code is exactly
 * what the tests exercise. Order matters: callees before `recorderBootstrap`,
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
  runReplayStep.toString(),
  recorderBootstrap.toString(),
  "recorderBootstrap();",
  "})();",
].join("\n");
