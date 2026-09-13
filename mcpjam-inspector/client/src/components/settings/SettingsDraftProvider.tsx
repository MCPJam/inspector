import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { UNSAFE_DataRouterContext } from "react-router";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";

type Draft = { dirty: boolean; pending: boolean; discard: () => void };
const DraftContext = createContext<
  ((id: string, draft: Draft | null) => void) | null
>(null);
export function useSettingsDraft(
  dirty: boolean,
  discard: () => void,
  pending = false,
) {
  const register = useContext(DraftContext);
  const id = useId();
  const callback = useRef(discard);
  callback.current = discard;
  useEffect(() => {
    if (!dirty && !pending) return;
    register?.(id, { dirty, pending, discard: () => callback.current() });
    return () => register?.(id, null);
  }, [register, id, dirty, pending]);
}
function RouterDraftGuard({
  dirty,
  pending,
  discard,
}: {
  dirty: boolean;
  pending: boolean;
  discard: () => void;
}) {
  useUnsavedChangesGuard(dirty || pending, discard, undefined, pending);
  return null;
}
export function SettingsDraftProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const router = useContext(UNSAFE_DataRouterContext);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const register = useCallback(
    (id: string, draft: Draft | null) =>
      setDrafts((old) => {
        const next = { ...old };
        if (draft) next[id] = draft;
        else delete next[id];
        return next;
      }),
    [],
  );
  const dirty = Object.values(drafts).some((d) => d.dirty);
  const pending = Object.values(drafts).some((d) => d.pending);
  const discard = useCallback(
    () =>
      Object.values(drafts).forEach((d) => {
        if (d.dirty) d.discard();
      }),
    [drafts],
  );
  useEffect(() => {
    if (!dirty && !pending) return;
    const handler = (event: Event) => {
      if (pending) {
        event.preventDefault();
        window.alert("Wait for your settings to finish saving.");
      } else if (
        !window.confirm("You have unsaved settings. Leave without saving?")
      )
        event.preventDefault();
      else discard();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("settings-before-navigation", handler);
    if (!router) window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("settings-before-navigation", handler);
      window.removeEventListener("beforeunload", unload);
    };
  }, [router, dirty, pending, discard]);
  return (
    <DraftContext.Provider value={register}>
      {router && enabled && (
        <RouterDraftGuard dirty={dirty} pending={pending} discard={discard} />
      )}
      {children}
    </DraftContext.Provider>
  );
}
