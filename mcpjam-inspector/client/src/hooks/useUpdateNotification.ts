import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  IDLE_UPDATE_STATE,
  type UpdateState,
} from "@/shared/update-state";

export function useUpdateNotification() {
  const [updateState, setUpdateState] = useState<UpdateState>({
    ...IDLE_UPDATE_STATE,
  });
  const previousPhaseRef = useRef<UpdateState["phase"]>(IDLE_UPDATE_STATE.phase);

  useEffect(() => {
    if (!window.isElectron || !window.electronAPI?.update) {
      return;
    }

    let isMounted = true;
    let receivedStatePush = false;

    const handleStateChanged = (nextState: UpdateState) => {
      receivedStatePush = true;

      if (isMounted) {
        setUpdateState(nextState);
      }
    };

    const unsubscribe = window.electronAPI.update.onStateChanged(handleStateChanged);

    void window.electronAPI.update
      .getState()
      .then((nextState) => {
        if (!receivedStatePush && isMounted) {
          setUpdateState(nextState);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (
      updateState.phase === "error" &&
      previousPhaseRef.current !== "error"
    ) {
      toast.error(updateState.errorMessage ?? "Update failed. Please try again.");
    }

    previousPhaseRef.current = updateState.phase;
  }, [updateState.errorMessage, updateState.phase]);

  const requestInstall = useCallback(() => {
    window.electronAPI?.update?.requestInstall();
  }, []);

  const simulateUpdate = useCallback(() => {
    window.electronAPI?.update?.simulateUpdate?.();
  }, []);

  return {
    updateState,
    showUpdateButton: updateState.phase !== "idle",
    updateButtonLabel: getUpdateButtonLabel(updateState),
    requestInstall,
    simulateUpdate,
  };
}

function getUpdateButtonLabel(updateState: UpdateState): string | null {
  return updateState.phase === "idle" ? null : "Update";
}
