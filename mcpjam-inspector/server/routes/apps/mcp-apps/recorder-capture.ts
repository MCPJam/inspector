/// <reference lib="dom" />
import type { ElementLocator, ScriptedStep } from "@/shared/scripted-steps";

type CaptureState = {
  mode: "record" | "pick" | "off";
  sequence: number;
  session: string;
  active: { target: Element; kind: string; id: string } | null;
  lastClick: { target: Element; id: string } | null;
  labelControl: Element | null;
  keyboardClick: boolean;
  replayMuted: boolean;
  userGesture: boolean;
  scrollAt: number;
  pastePending: boolean;
  values: WeakMap<Element, string>;
  locate: (el: Element) => ElementLocator;
  toStep: (event: Event) => ScriptedStep | null;
};

function captureId(
  state: CaptureState,
  target: Element,
  kind: string,
  update = false,
): string {
  if (update && state.active?.target === target && state.active.kind === kind)
    return state.active.id;
  const id = `${state.session}-${++state.sequence}`;
  state.active = { target, kind, id };
  return id;
}

function sendCapture(step: ScriptedStep, id: string): void {
  window.parent.postMessage(
    { type: "recorder:step", step, captureId: id },
    "*",
  );
}

function captureClick(
  event: MouseEvent,
  target: Element,
  state: CaptureState,
): void {
  if (
    target.closest("select,option") ||
    target === state.labelControl ||
    (event.detail === 0 && state.keyboardClick)
  )
    return;
  const label = target.closest("label");
  if (
    event.type === "click" &&
    label instanceof HTMLLabelElement &&
    label.control
  ) {
    target = label.control;
    state.labelControl = target;
  }
  const double =
    event.type === "click" &&
    event.detail === 2 &&
    state.lastClick?.target === target;
  const id = double ? state.lastClick!.id : captureId(state, target, "click");
  sendCapture(
    {
      kind: "click",
      target: state.locate(target),
      ...(event.type === "contextmenu"
        ? { clickType: "right" }
        : double
          ? { clickType: "double" }
          : {}),
    },
    id,
  );
  state.lastClick = event.type === "click" ? { target, id } : null;
}

function captureValue(
  event: Event,
  target: Element,
  state: CaptureState,
): void {
  const step = state.toStep(event);
  if (!step || (step.kind !== "type" && step.kind !== "select")) return;
  state.pastePending = false;
  const value = step.kind === "type" ? step.text : JSON.stringify(step.values);
  if (state.values.get(target) === value && event.type === "change") return;
  state.values.set(target, value);
  state.lastClick = null;
  sendCapture(step, captureId(state, target, step.kind, true));
}

function captureKey(
  event: KeyboardEvent,
  target: Element,
  state: CaptureState,
): void {
  if (
    event.isComposing ||
    [
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "AltGraph",
      "Dead",
      "Process",
      "Unidentified",
    ].includes(event.key)
  )
    return;
  const editable = target.matches(
    "input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]",
  );
  const textKey =
    event.key.length === 1 &&
    (event.getModifierState("AltGraph") ||
      (!event.ctrlKey &&
        !event.metaKey &&
        (!event.altKey || /[^\x20-\x7e]/.test(event.key))));
  const editing =
    editable &&
    (textKey ||
      ["Backspace", "Delete"].includes(event.key) ||
      ((event.ctrlKey || event.metaKey) && /^[acvxyz]$/i.test(event.key)));
  if (editable && (event.ctrlKey || event.metaKey) && /^v$/i.test(event.key))
    state.pastePending = true;
  if (
    editing ||
    (target.matches("select") && !["Tab", "Escape"].includes(event.key))
  )
    return;
  const key = [
    ...(event.ctrlKey ? ["Control"] : []),
    ...(event.metaKey ? ["Meta"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    event.key === " "
      ? "Space"
      : event.key === "+"
        ? event.code || "Equal"
        : event.key,
  ].join("+");
  state.keyboardClick = event.key === "Enter" || event.key === " ";
  state.lastClick = null;
  sendCapture(
    { kind: "key", key, target: state.locate(target) },
    captureId(state, target, "key"),
  );
}

function captureScroll(event: Event, state: CaptureState): void {
  if (!state.userGesture || state.replayMuted) return;
  const target =
    event.target === document ? document.scrollingElement : event.target;
  if (!(target instanceof Element)) return;
  const continuation = event.timeStamp - state.scrollAt <= 200;
  state.scrollAt = event.timeStamp;
  sendCapture(
    {
      kind: "scrollTo",
      target:
        event.target === document || target === document.scrollingElement
          ? { css: "html" }
          : state.locate(target),
      x: target.scrollLeft,
      y: target.scrollTop,
    },
    captureId(state, target, "scrollTo", continuation),
  );
}

function captureEvent(event: Event, state: CaptureState): void {
  if (state.mode === "off") return;
  if (
    !event.isTrusted &&
    (!state.userGesture || !["input", "change", "scroll"].includes(event.type))
  )
    return;
  if (state.mode === "pick") {
    if (
      [
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
        "dblclick",
        "contextmenu",
        "keydown",
        "keyup",
      ].includes(event.type)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerdown" && event.target instanceof Element)
        window.parent.postMessage(
          { type: "recorder:pick", target: state.locate(event.target) },
          "*",
        );
    }
    return;
  }
  if (
    event.isTrusted &&
    ["pointerdown", "keydown", "input", "change", "wheel"].includes(event.type)
  ) {
    state.userGesture = true;
    state.replayMuted = false;
  }
  if (state.replayMuted) return;
  if (event.type === "scroll") return captureScroll(event, state);
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (event.type === "pointerdown") {
    state.keyboardClick = false;
    state.labelControl = null;
    state.active = null;
  } else if (event.type === "click" || event.type === "contextmenu")
    captureClick(event as MouseEvent, target, state);
  else if (event.type === "input" || event.type === "change")
    captureValue(event, target, state);
  else if (event.type === "keydown")
    captureKey(event as KeyboardEvent, target, state);
}

function flushCapture(state: CaptureState, id: number): void {
  const deadline = Date.now() + 1000;
  const finish = () => {
    if (
      state.mode === "record" &&
      state.pastePending &&
      Date.now() < deadline
    ) {
      setTimeout(finish, 10);
      return;
    }
    if (
      state.mode === "record" &&
      state.active &&
      ["type", "select"].includes(state.active.kind)
    ) {
      const event = new Event("change");
      Object.defineProperty(event, "target", { value: state.active.target });
      captureValue(event, state.active.target, state);
    }
    state.mode = "off";
    state.pastePending = false;
    window.parent.postMessage({ type: "recorder:flushed", id, ok: true }, "*");
  };
  finish();
}

function installRecorder(
  locate: CaptureState["locate"],
  toStep: CaptureState["toStep"],
  replay: (
    step: ScriptedStep,
  ) => Promise<{ ok: boolean; reason?: string; deferred?: string }>,
): void {
  const state: CaptureState = {
    mode: "off",
    sequence: 0,
    session: Math.random().toString(36).slice(2),
    active: null,
    lastClick: null,
    labelControl: null,
    keyboardClick: false,
    replayMuted: false,
    userGesture: false,
    scrollAt: Number.NEGATIVE_INFINITY,
    pastePending: false,
    values: new WeakMap(),
    locate,
    toStep,
  };
  const handler = (event: Event) => captureEvent(event, state);
  [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
    "input",
    "change",
    "keydown",
    "keyup",
    "wheel",
    "scroll",
  ].forEach((type) =>
    window.addEventListener(type, handler, { capture: true, passive: false }),
  );
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (data?.type === "recorder:flush" && typeof data.id === "number") {
      flushCapture(state, data.id);
      return;
    }
    if (
      data?.type === "recorder:configure" &&
      ["record", "pick", "off"].includes(data.mode)
    ) {
      if (state.mode !== data.mode) {
        state.active = null;
        state.lastClick = null;
      }
      state.mode = data.mode;
    } else if (data?.type === "recorder:replay-step") {
      state.replayMuted = true;
      state.active = null;
      replay(data.step).then((result) =>
        window.parent.postMessage(
          { type: "recorder:replay-result", id: data.id, ...result },
          "*",
        ),
      );
    }
  });
  const ready = () =>
    window.parent.postMessage({ type: "recorder:ready" }, "*");
  ready();
  [50, 250, 1000, 2500].forEach((delay) => window.setTimeout(ready, delay));
  window.addEventListener("load", ready, { once: true });
  const heartbeat = window.setInterval(ready, 2000);
  window.addEventListener("pagehide", () => window.clearInterval(heartbeat), {
    once: true,
  });
}

// Serialized functions only reference each other, their arguments and DOM globals.
export const RECORDER_CAPTURE_JS = [
  captureId,
  sendCapture,
  captureClick,
  captureValue,
  captureKey,
  captureScroll,
  captureEvent,
  flushCapture,
  installRecorder,
]
  .map((fn) => fn.toString())
  .join("\n");
