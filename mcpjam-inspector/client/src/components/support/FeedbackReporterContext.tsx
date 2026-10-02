import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SendFeedbackDialog,
  type SendFeedbackDefaults,
} from "./SendFeedbackDialog";

/**
 * Lets a component deep in the tree open the Send feedback dialog —
 * `ErrorCard`'s "Report this" — without calling Convex itself.
 *
 * `null` unless an ENABLED provider is above it, and the app shell enables it
 * only for a signed-in member on the hosted app. So a card rendered anywhere
 * else (local mode, a guest, a bare component test) sees `null` and offers no
 * link, and never needs a Convex client to render.
 */
export type FeedbackReporter = {
  openFeedback: (defaults?: SendFeedbackDefaults) => void;
};

const FeedbackReporterContext = createContext<FeedbackReporter | null>(null);

export function useFeedbackReporter(): FeedbackReporter | null {
  return useContext(FeedbackReporterContext);
}

/**
 * Always rendered by the shell, switched by `enabled`, rather than mounted and
 * unmounted: wrapping the app in a provider only once membership settles would
 * remount everything beneath it at that moment.
 */
export function FeedbackReporterProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [defaults, setDefaults] = useState<SendFeedbackDefaults | undefined>(
    undefined,
  );
  const openFeedback = useCallback((next?: SendFeedbackDefaults) => {
    setDefaults(next);
    setOpen(true);
  }, []);
  const value = useMemo(
    () => (enabled ? { openFeedback } : null),
    [enabled, openFeedback],
  );
  return (
    <FeedbackReporterContext.Provider value={value}>
      {children}
      {enabled ? (
        <SendFeedbackDialog
          open={open}
          onOpenChange={setOpen}
          defaults={defaults}
        />
      ) : null}
    </FeedbackReporterContext.Provider>
  );
}
