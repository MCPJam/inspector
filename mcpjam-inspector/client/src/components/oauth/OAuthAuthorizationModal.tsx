import { useCallback, useEffect, useRef } from "react";
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
  /** Bump while a sign-in is pending to open its popup again. */
  reopenRequest?: number;
}

export const OAuthAuthorizationModal = ({
  open,
  onOpenChange,
  authorizationUrl,
  onCallback,
  reopenRequest = 0,
}: OAuthAuthorizationModalProps) => {
  const hasOpenedRef = useRef(false);
  const {
    start: startHandoff,
    reopen: reopenHandoff,
    cancel: cancelHandoff,
  } = useOAuthPopupHandoff();
  const latestRef = useRef({ onOpenChange, onCallback });
  latestRef.current = { onOpenChange, onCallback };
  const seenReopenRequestRef = useRef(reopenRequest);

  const close = useCallback(() => {
    latestRef.current.onOpenChange(false);
    hasOpenedRef.current = false;
  }, []);

  // Open popup when modal opens
  useEffect(() => {
    if (open && !hasOpenedRef.current) {
      hasOpenedRef.current = true;
      let cancelled = false;

      // The handoff outlives the modal's open state: a COOP provider page
      // makes the popup read as closed while the user is still signing in.
      const openAuthorizationPopup = () => {
        const started = startHandoff({
          authorizationUrl,
          flow: "debugger",
          deadlineMs: OAUTH_POPUP_MARKER_TTL_MS,
          retryLabel: "try again",
          onResult: (message) => {
            latestRef.current.onCallback?.(message);
            close();
          },
          onExpire: close,
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
  }, [open, authorizationUrl, startHandoff, close]);

  useEffect(() => {
    if (reopenRequest === seenReopenRequestRef.current) return;
    seenReopenRequestRef.current = reopenRequest;
    if (!reopenHandoff()) {
      cancelHandoff();
      close();
    }
  }, [reopenRequest, reopenHandoff, cancelHandoff, close]);

  // This component doesn't render anything - it just manages the popup
  return null;
};
