import { useCallback, useState } from "react";

interface UseModelSelectorLayoutLockReturn {
  isMultiModelLayoutMode: boolean;
  onModelSelectorOpenChange: (open: boolean) => void;
}

/**
 * Keep the current single-model or multi-model surface mounted while the model
 * selector is open so toggling compare mode does not remount the composer.
 */
export function useModelSelectorLayoutLock(
  isMultiModelMode: boolean,
): UseModelSelectorLayoutLockReturn {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [multiModelLayoutModeWhileSelectorOpen, setMultiModelLayoutModeWhileSelectorOpen] =
    useState<boolean | null>(null);

  const isMultiModelLayoutMode = isModelSelectorOpen
    ? (multiModelLayoutModeWhileSelectorOpen ?? isMultiModelMode)
    : isMultiModelMode;

  const onModelSelectorOpenChange = useCallback(
    (open: boolean) => {
      setIsModelSelectorOpen(open);
      if (open) {
        setMultiModelLayoutModeWhileSelectorOpen(isMultiModelMode);
      } else {
        setMultiModelLayoutModeWhileSelectorOpen(null);
      }
    },
    [isMultiModelMode],
  );

  return {
    isMultiModelLayoutMode,
    onModelSelectorOpenChange,
  };
}
