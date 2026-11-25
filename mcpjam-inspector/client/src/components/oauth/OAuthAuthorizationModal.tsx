import { useEffect, useRef } from "react";
import { OAUTH_POPUP_MARKER_TTL_MS } from "@/lib/oauth/popup-handoff-marker";
import {
  useOAuthPopupHandoff,
  type OAuthCallbackMessage,
} from "@/lib/oauth/popup-handoff";

interface OAuthAuthorizationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  authorizationUrl: string;
  /** The popup's answer: a code or a provider error, its `state` checked. */
  onCallback?: (message: OAuthCallbackMessage) => void;
}

export const OAuthAuthorizationModal = ({
  open,
  onOpenChange,
  authorizationUrl,
  onCallback,
}: OAuthAuthorizationModalProps) => {
  const hasOpenedRef = useRef(false);
  const handoff = useOAuthPopupHandoff();
  const latestRef = useRef({ onOpenChange, onCallback });
  latestRef.current = { onOpenChange, onCallback };

  // Open popup when modal opens
  useEffect(() => {
    if (open && !hasOpenedRef.current) {
      hasOpenedRef.current = true;
      let cancelled = false;

      const close = () => {
        latestRef.current.onOpenChange(false);
        hasOpenedRef.current = false;
      };

      // The handoff outlives the modal's open state: a COOP provider page
      // makes the popup read as closed while the user is still signing in.
      const openAuthorizationPopup = () => {
        const started = handoff.start({
          authorizationUrl,
          flow: "debugger",
          deadlineMs: OAUTH_POPUP_MARKER_TTL_MS,
          retryLabel: "try again",
          onResult: (message) => {
            latestRef.current.onCallback?.(message);
            close();
          },
        });
        if (!started.popup) {
          started.cancel();
          close();
        }
      };

      const openExternal = window.electronAPI?.app?.openExternal;
      if (window.isElectron && openExternal) {
        void (async () => {
          try {
            await openExternal(authorizationUrl);
            if (cancelled) return;
            close();
          } catch (error) {
            console.error(
              "[OAuth Popup] Failed to open system browser:",
              error,
            );
            if (cancelled) return;
            openAuthorizationPopup();
          }
        })();

        return () => {
          cancelled = true;
        };
      }

      openAuthorizationPopup();
      return;
    }

    // Reset flag when modal closes
    if (!open) {
      hasOpenedRef.current = false;
    }
  }, [open, authorizationUrl, handoff.start]);

  // This component doesn't render anything - it just manages the popup
  return null;
};
