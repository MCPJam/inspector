import { useEffect, useRef } from "react";

interface OAuthAuthorizationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  authorizationUrl: string;
  onAuthorizationComplete?: () => void;
}

export const OAuthAuthorizationModal = ({
  open,
  onOpenChange,
  authorizationUrl,
  onAuthorizationComplete,
}: OAuthAuthorizationModalProps) => {
  const popupRef = useRef<Window | null>(null);
  const hasOpenedRef = useRef(false);

  // Listen for OAuth callback messages from popup
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Verify origin matches our app
      if (event.origin !== window.location.origin) {
        return;
      }

      // Check if this is an OAuth callback message
      if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
        console.log("[OAuth Popup] Received OAuth callback");
        // Notify parent component
        onAuthorizationComplete?.();
        // Close our "modal" state
        onOpenChange(false);
        hasOpenedRef.current = false;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onOpenChange, onAuthorizationComplete]);

  // Open popup when modal opens
  useEffect(() => {
    if (open && !hasOpenedRef.current) {
      hasOpenedRef.current = true;
      console.log("[OAuth Popup] Opening authorization in popup window");

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      // Use unique window name each time to prevent reusing old popup with stale auth code
      const uniqueWindowName = `oauth_authorization_${Date.now()}`;

      popupRef.current = window.open(
        authorizationUrl,
        uniqueWindowName,
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes`
      );

      // Monitor popup closure
      const checkPopupClosed = setInterval(() => {
        if (popupRef.current?.closed) {
          console.log("[OAuth Popup] Popup was closed");
          clearInterval(checkPopupClosed);
          onOpenChange(false);
          hasOpenedRef.current = false;
        }
      }, 500);

      // Cleanup
      return () => {
        clearInterval(checkPopupClosed);
      };
    }

    // Reset flag when modal closes
    if (!open) {
      hasOpenedRef.current = false;
    }
  }, [open, authorizationUrl, onOpenChange]);

  // This component doesn't render anything - it just manages the popup
  return null;
};
