import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConversationExecutionTarget,
  ComposerExecutionTarget,
} from "@/lib/conversation-execution-target";
import { describeConversationTargetDisclosure } from "@/lib/conversation-execution-target";

/** Select through the existing pickers, then wait for their scope reset before
 * hydrating history. A newer selection/project/unmount cancels the old load. */
export function useConversationTargetRestoration(input: {
  projectId: string | null;
  composer: ComposerExecutionTarget;
  settled: boolean;
  hostsLoading: boolean;
  hostIds: string[];
  environmentsEnabled: boolean;
  selectHost: (id: string | null) => void;
  selectEnvironment: (id: string) => void;
  clearEnvironment: () => void;
}) {
  type Request = {
    target: ConversationExecutionTarget;
    projectId: string | null;
    shouldApply: () => boolean;
    resolve: (apply: boolean) => void;
    selected: boolean;
    initialComposer?: ComposerExecutionTarget;
    matched: boolean;
  };
  const [pending, setPending] = useState<Request | null>(null);
  const pendingRef = useRef<Request | null>(null);
  const restoreTarget = useCallback(
    (target: ConversationExecutionTarget, shouldApply: () => boolean) => {
      pendingRef.current?.resolve(false);
      if (target.kind === "unrecorded") {
        pendingRef.current = null;
        setPending(null);
        return Promise.resolve(shouldApply());
      }
      return new Promise<boolean>((resolve) => {
        const request = {
          target,
          projectId: input.projectId,
          shouldApply,
          resolve,
          selected: false,
          matched: false,
        };
        pendingRef.current = request;
        setPending(request);
      });
    },
    [input.projectId],
  );

  useEffect(() => {
    if (!pending) return;
    const finish = (apply: boolean) => {
      pending.resolve(apply);
      if (pendingRef.current === pending) pendingRef.current = null;
      setPending(null);
    };
    if (pending.projectId !== input.projectId || !pending.shouldApply()) {
      finish(false);
      return;
    }
    const target = pending.target;
    if (!pending.selected) {
      if (target.kind === "host" && input.hostsLoading) return;
      // Unavailable targets remain disclosed against the current selection.
      // Never substitute another host and claim it is the saved one.
      if (
        (target.kind === "host" && !input.hostIds.includes(target.hostId)) ||
        (target.kind === "environment" && !input.environmentsEnabled)
      ) {
        if (input.settled) finish(true);
        return;
      }
      pending.selected = true;
      pending.initialComposer = input.composer;
      if (target.kind === "environment")
        input.selectEnvironment(target.environmentId);
      else if (target.kind === "host" || target.kind === "adhoc") {
        input.clearEnvironment();
        input.selectHost(target.kind === "host" ? target.hostId : null);
      }
    }
    const matches =
      describeConversationTargetDisclosure({
        recorded: target,
        composer: input.composer,
      }).kind === "none";
    const initial = pending.initialComposer;
    const stillInitial =
      initial?.kind === "environment"
        ? input.composer.kind === "environment" &&
          input.composer.environmentId === initial.environmentId
        : input.composer.kind === "host" &&
          input.composer.hostId === initial?.hostId;
    if (!matches && (pending.matched || !stillInitial)) {
      finish(false);
      return;
    }
    pending.matched ||= matches;
    if (input.settled && matches) {
      finish(true);
    }
  }, [pending, input]);

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
    },
    [],
  );
  return { restoreTarget, restoringTarget: pending?.target ?? null };
}
