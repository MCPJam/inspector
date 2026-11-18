import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppNavigate } from "@/lib/app-navigation";
import { hasStoredThemePreference } from "@/lib/theme-utils";
import { DarkDefaultNudgeCard } from "./DarkDefaultNudgeCard";
import { useAnnouncementSlot } from "./announcement-slot";

export const DARK_DEFAULT_NUDGE_KEY = "darkDefaultNudgeSeen";
const TOAST_ID = "dark-default-nudge";

function shouldShowNudge(): boolean {
  if (hasStoredThemePreference()) return false;
  try {
    return localStorage.getItem(DARK_DEFAULT_NUDGE_KEY) === null;
  } catch (error) {
    // No storage means no way to remember the nudge, so never show it.
    console.warn("Cannot access localStorage for dark default nudge:", error);
    return false;
  }
}

function markNudgeSeen(): boolean {
  try {
    localStorage.setItem(DARK_DEFAULT_NUDGE_KEY, "1");
    return true;
  } catch (error) {
    // Unsaved means it would show on every load, so skip it instead.
    console.warn("Failed to persist dark default nudge:", error);
    return false;
  }
}

function DarkDefaultToast({
  id,
  contentRef,
}: {
  id: string | number;
  contentRef: (node: HTMLElement | null) => void;
}) {
  const navigate = useAppNavigate();
  return (
    <DarkDefaultNudgeCard
      ref={contentRef}
      onDismiss={() => toast.dismiss(id)}
      onOpenSettings={() => {
        toast.dismiss(id);
        navigate("/settings/appearance");
      }}
    />
  );
}

/**
 * Tells people who never picked a theme that dark is now the default, once
 * per device. Renders nothing; mount it after `<Toaster />`.
 */
export function DarkDefaultNudge({ enabled = true }: { enabled?: boolean }) {
  const [pending, setPending] = useState(false);
  const { open, contentRef } = useAnnouncementSlot(enabled && pending);

  useEffect(() => {
    setPending(enabled && shouldShowNudge());
    if (enabled) {
      return () => {
        toast.dismiss(TOAST_ID);
      };
    }
  }, [enabled]);

  useEffect(() => {
    if (!open) return;
    if (!shouldShowNudge() || !markNudgeSeen()) {
      setPending(false);
      return;
    }
    toast.custom(
      (id) => <DarkDefaultToast id={id} contentRef={contentRef} />,
      {
        id: TOAST_ID,
        duration: 20_000,
        onDismiss: () => setPending(false),
        onAutoClose: () => setPending(false),
      },
    );
  }, [contentRef, open]);

  return null;
}
