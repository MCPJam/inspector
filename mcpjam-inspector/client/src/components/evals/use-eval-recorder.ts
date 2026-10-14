import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  elementLocatorSchema,
  interactActionSchema,
} from "@mcpjam/sdk/contract";
import {
  insertStepAfter,
  lastStepIdOfTurn,
  newStepId,
  stepAssertionToWidgetAssertion,
  type TestStep,
} from "@/shared/steps";
import type { StepAssertion } from "@/shared/scripted-steps";
import type {
  RecorderProps,
  RecorderStepEvent,
  RecorderPickEvent,
  RecorderFlushControllerEvent,
} from "@/components/chat-v2/thread/recorder-types";
import type { AssertPick } from "./assert-pick-chooser";
import { toast } from "sonner";

export function saveRecordedWidgetStep(
  steps: TestStep[],
  turnIndex: number,
  step: TestStep,
): TestStep[] {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) return steps;
  const anchor = lastStepIdOfTurn(steps, turnIndex);
  if (!anchor) return steps;
  const existing = steps.findIndex((saved) => saved.id === step.id);
  if (existing !== -1)
    return steps.map((saved, index) => (index === existing ? step : saved));
  return insertStepAfter(steps, anchor, step);
}

type RecorderOptions<T extends { steps: TestStep[] }> = {
  enabled: boolean;
  active: boolean;
  mode: "record" | "assert";
  caseId: string | undefined;
  setForm: Dispatch<SetStateAction<T | null>>;
  onStop: () => void;
};

function useRecorderStop<T extends { steps: TestStep[] }>(
  latest: { current: RecorderOptions<T> },
  caseId: string | undefined,
) {
  const controllers = useRef(
    new Map<string, NonNullable<RecorderFlushControllerEvent["flush"]>>(),
  );
  const stopping = useRef<Promise<void> | null>(null);
  useEffect(() => {
    controllers.current.clear();
  }, [caseId]);
  const onRecorderFlushReady = useCallback<
    NonNullable<RecorderProps["onRecorderFlushReady"]>
  >(
    (event) => {
      if (latest.current.caseId !== caseId) return;
      if (event.flush) controllers.current.set(event.toolCallId, event.flush);
      else controllers.current.delete(event.toolCallId);
    },
    [caseId, latest],
  );
  const stopRecording = useCallback(() => {
    if (stopping.current) return stopping.current;
    const stop = async () => {
      const results = await Promise.allSettled(
        [...controllers.current.values()].map((flush) => flush()),
      );
      const current = latest.current;
      if (!current.enabled || current.caseId !== caseId) return;
      if (
        results.some(
          (result) => result.status === "rejected" || !result.value.ok,
        )
      ) {
        toast.error(
          "Could not finish recording. Keep this window open and try again.",
        );
        return;
      }
      current.onStop();
    };
    stopping.current = stop().finally(() => {
      stopping.current = null;
    });
    return stopping.current;
  }, [caseId, latest]);
  return { onRecorderFlushReady, stopRecording };
}

function updateRecordedForm<T extends { steps: TestStep[] }>(
  setForm: RecorderOptions<T>["setForm"],
  turnIndex: number,
  step: TestStep,
) {
  setForm((form) =>
    form
      ? { ...form, steps: saveRecordedWidgetStep(form.steps, turnIndex, step) }
      : form,
  );
}

function useRecorderCaptures<T extends { steps: TestStep[] }>(
  latest: { current: RecorderOptions<T> },
  caseId: string | undefined,
  setPendingPick: Dispatch<SetStateAction<AssertPick | null>>,
) {
  const onRecorderStep = useCallback(
    (event: RecorderStepEvent) => {
      const current = latest.current;
      if (
        !current.enabled ||
        !current.active ||
        current.mode !== "record" ||
        current.caseId !== caseId
      )
        return;
      const parsed = interactActionSchema.safeParse(event.step);
      if (!parsed.success) {
        console.warn("Could not record widget action", parsed.error.message);
        return;
      }
      const step: TestStep = {
        id: event.captureId
          ? `recorded-${event.toolCallId}-${event.captureId}`
          : newStepId("interact"),
        kind: "interact",
        toolName: event.toolName,
        action: parsed.data,
      };
      updateRecordedForm(current.setForm, event.promptIndex, step);
    },
    [caseId, latest],
  );
  const onRecorderPick = useCallback(
    (event: RecorderPickEvent) => {
      const current = latest.current;
      if (
        !current.enabled ||
        !current.active ||
        current.mode !== "assert" ||
        current.caseId !== caseId
      )
        return;
      const parsed = elementLocatorSchema.safeParse(event.target);
      if (
        parsed.success &&
        Number.isInteger(event.promptIndex) &&
        event.promptIndex >= 0
      )
        setPendingPick({
          promptIndex: event.promptIndex,
          toolName: event.toolName,
          locator: parsed.data,
        });
    },
    [caseId, latest, setPendingPick],
  );
  return { onRecorderStep, onRecorderPick };
}

export function useEvalRecorder<T extends { steps: TestStep[] }>(
  options: RecorderOptions<T>,
) {
  const latest = useRef(options);
  latest.current = options;
  const [pendingPick, setPendingPick] = useState<AssertPick | null>(null);
  useEffect(
    () => setPendingPick(null),
    [options.caseId, options.enabled, options.active],
  );
  const caseId = options.caseId;
  const { onRecorderFlushReady, stopRecording } = useRecorderStop(
    latest,
    caseId,
  );
  const { onRecorderStep, onRecorderPick } = useRecorderCaptures(
    latest,
    caseId,
    setPendingPick,
  );
  const confirmPick = useCallback(
    (assertion: StepAssertion) => {
      const current = latest.current;
      if (
        !current.enabled ||
        !current.active ||
        current.caseId !== caseId ||
        !pendingPick
      )
        return;
      const step: TestStep = {
        id: newStepId("wassert"),
        kind: "assert",
        assertion: stepAssertionToWidgetAssertion(
          pendingPick.toolName,
          assertion,
        ),
      };
      updateRecordedForm(current.setForm, pendingPick.promptIndex, step);
      setPendingPick(null);
    },
    [caseId, pendingPick],
  );
  const recorder = useMemo<RecorderProps | undefined>(
    () =>
      options.enabled
        ? {
            recordCapable: true,
            recorderCaptureMode: options.active
              ? options.mode === "assert"
                ? "pick"
                : "record"
              : "off",
            onRecorderStep,
            onRecorderPick,
            onRecorderFlushReady,
          }
        : undefined,
    [
      options.enabled,
      options.active,
      options.mode,
      onRecorderStep,
      onRecorderPick,
      onRecorderFlushReady,
    ],
  );
  return { recorder, pendingPick, setPendingPick, confirmPick, stopRecording };
}
