import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { DialogContent } from "@mcpjam/design-system/dialog";
import "./settings-dialog-presentation.css";

export type SettingsDisplayMode = "inline" | "fullscreen";
type Claim = {
  id: string;
  mode: SettingsDisplayMode;
  dismiss: () => void;
  hasPendingForm: boolean;
};
type Presentation = {
  active: boolean;
  fullscreen: boolean;
  contentProps: Pick<
    ComponentProps<typeof DialogContent>,
    "style" | "showCloseButton" | "onEscapeKeyDown"
  >;
  claim(
    id: string,
    mode: SettingsDisplayMode,
    dismiss: () => void,
    hasPendingForm?: boolean,
  ): void;
  release(id: string): void;
  dismissApp(): boolean;
};
const Context = createContext<Presentation | null>(null);
export const SETTINGS_FULLSCREEN_STYLE: CSSProperties = {
  inset: 0,
  width: "100vw",
  height: "100dvh",
  maxWidth: "100vw",
  maxHeight: "100dvh",
  // Dialog centering uses an independent CSS translate in addition to transform.
  translate: "none",
  transform: "none",
  borderRadius: 0,
  padding: 12,
};

/** One existing Settings dialog owns its App's presentation and close action. */
export function SettingsDialogPresentationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [current, setCurrent] = useState<Claim | null>(null);
  const claim = useCallback(
    (
      id: string,
      mode: SettingsDisplayMode,
      dismiss: () => void,
      hasPendingForm = false,
    ) => {
      setCurrent((old) =>
        old?.id === id &&
        old.mode === mode &&
        old.dismiss === dismiss &&
        old.hasPendingForm === hasPendingForm
          ? old
          : { id, mode, dismiss, hasPendingForm },
      );
    },
    [],
  );
  const release = useCallback(
    (id: string) => setCurrent((old) => (old?.id === id ? null : old)),
    [],
  );
  const value = useMemo<Presentation>(
    () => ({
      active: current !== null,
      fullscreen: current?.mode === "fullscreen",
      contentProps: {
        style:
          current?.mode === "fullscreen"
            ? SETTINGS_FULLSCREEN_STYLE
            : current
              ? { height: "85dvh" }
              : undefined,
        showCloseButton: current === null,
        onEscapeKeyDown(event) {
          if (current?.hasPendingForm) event.preventDefault();
        },
      },
      claim,
      release,
      dismissApp() {
        if (!current) return false;
        current.dismiss();
        return true;
      },
    }),
    [current, claim, release],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useSettingsDialogPresentation = () => useContext(Context);
