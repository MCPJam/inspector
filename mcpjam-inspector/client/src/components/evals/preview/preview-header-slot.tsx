import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";

const PreviewHeaderSlotContext = createContext<
  ((node: ReactNode | null) => void) | null
>(null);

export function PreviewHeaderSlotProvider({
  onSlotChange,
  children,
}: {
  onSlotChange: (node: ReactNode | null) => void;
  children: ReactNode;
}) {
  return (
    <PreviewHeaderSlotContext.Provider value={onSlotChange}>
      {children}
    </PreviewHeaderSlotContext.Provider>
  );
}

/** Renders children into the CasePreviewPane header row (below Preview | Runs). */
export function PreviewHeaderSlot({ children }: { children: ReactNode }) {
  const onSlotChange = useContext(PreviewHeaderSlotContext);
  useLayoutEffect(() => {
    if (!onSlotChange) {
      return undefined;
    }
    onSlotChange(children);
    return () => onSlotChange(null);
  }, [children, onSlotChange]);

  if (onSlotChange) {
    return null;
  }

  return <>{children}</>;
}
