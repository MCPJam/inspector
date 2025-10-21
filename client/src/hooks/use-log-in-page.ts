import { useEffect } from "react";
import type { SetStateAction } from "react";
import { useConvexAuth } from "convex/react";
import { create } from "zustand";

interface LoginPageStore {
  shouldShowLoginPage: boolean;
  dismissedByUser: boolean;
  setShouldShowLoginPage: (value: SetStateAction<boolean>) => void;
  showLoginPage: () => void;
  hideLoginPage: () => void;
}

const useLoginPageStore = create<LoginPageStore>((set) => ({
  shouldShowLoginPage: false,
  dismissedByUser: false,
  setShouldShowLoginPage: (value) =>
    set((state) => {
      const nextValue =
        typeof value === "function"
          ? (value as (prev: boolean) => boolean)(state.shouldShowLoginPage)
          : value;

      return {
        shouldShowLoginPage: nextValue,
        dismissedByUser: nextValue ? false : true,
      };
    }),
  showLoginPage: () =>
    set({ shouldShowLoginPage: true, dismissedByUser: false }),
  hideLoginPage: () =>
    set({ shouldShowLoginPage: false, dismissedByUser: true }),
}));

interface UseLoginPageResult {
  shouldShowLoginPage: boolean;
  setShouldShowLoginPage: (value: SetStateAction<boolean>) => void;
  showLoginPage: () => void;
  hideLoginPage: () => void;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
}

let previousAuthState: boolean | null = null;

export function useLoginPage(): UseLoginPageResult {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const shouldShowLoginPage = useLoginPageStore(
    (state) => state.shouldShowLoginPage,
  );
  const setShouldShowLoginPage = useLoginPageStore(
    (state) => state.setShouldShowLoginPage,
  );
  const showLoginPage = useLoginPageStore((state) => state.showLoginPage);
  const hideLoginPage = useLoginPageStore((state) => state.hideLoginPage);

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    if (isAuthenticated) {
      useLoginPageStore.setState({
        shouldShowLoginPage: false,
        dismissedByUser: false,
      });
    } else {
      const { dismissedByUser } = useLoginPageStore.getState();
      const shouldAutoOpen =
        (previousAuthState === null || previousAuthState === true) &&
        !dismissedByUser;

      if (shouldAutoOpen) {
        useLoginPageStore.setState({
          shouldShowLoginPage: true,
          dismissedByUser: false,
        });
      }
    }

    previousAuthState = isAuthenticated;
  }, [isAuthenticated, isAuthLoading]);

  return {
    shouldShowLoginPage,
    setShouldShowLoginPage,
    showLoginPage,
    hideLoginPage,
    isAuthenticated,
    isAuthLoading,
  };
}
