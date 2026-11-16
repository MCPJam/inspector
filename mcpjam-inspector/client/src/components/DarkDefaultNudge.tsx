import { useEffect } from "react";
import { toast } from "sonner";
import { useAppNavigate } from "@/lib/app-navigation";
import { hasStoredThemePreference } from "@/lib/theme-utils";
import { DarkDefaultNudgeCard } from "./DarkDefaultNudgeCard";

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

/**
 * Tells people who never picked a theme that dark is now the default, once
 * per device. Renders nothing; mount it after `<Toaster />`.
 */
export function DarkDefaultNudge() {
  const navigate = useAppNavigate();

  useEffect(() => {
    if (!shouldShowNudge() || !markNudgeSeen()) return;
    toast.custom(
      (id) => (
        <DarkDefaultNudgeCard
          onDismiss={() => toast.dismiss(id)}
          onOpenSettings={() => {
            toast.dismiss(id);
            navigate("/settings/appearance");
          }}
        />
      ),
      { id: TOAST_ID, duration: 20_000 },
    );
  }, [navigate]);

  return null;
}
