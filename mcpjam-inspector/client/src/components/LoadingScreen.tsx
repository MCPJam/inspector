import { useRef } from "react";

const SPINNER_ROTATION_MS = 1000;

function getSpinnerAnimationDelay() {
  const now =
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  return `-${now % SPINNER_ROTATION_MS}ms`;
}

interface LoadingScreenProps {
  // Optional status line shown under the spinner. The first-run NUX passes this
  // so the multi-second connect/provisioning wait reads as intentional instead
  // of a frozen, unbranded spinner. See BB-106.
  message?: string;
}

export default function LoadingScreen({ message }: LoadingScreenProps) {
  const animationDelayRef = useRef(getSpinnerAnimationDelay());

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-6 text-center">
        {/*
          BB-106: keep MCPJam branding visible on every full-screen load.
          `mcp_jam.svg` is a self-contained icon mark (its own background), so it
          needs no theme logic and never triggers a mid-flow refetch/flicker.
        */}
        <img
          src="/mcp_jam.svg"
          alt="MCPJam"
          draggable={false}
          className="h-16 w-16"
        />
        {/*
          BB-106: announce the loading state to assistive tech. The spinner is
          decorative (aria-hidden); screen readers read the status line (or an
          sr-only "Loading" fallback) out of this polite live region.
        */}
        <div
          className="flex flex-col items-center gap-6"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div
            aria-hidden="true"
            className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 border-t-primary"
            style={{ animationDelay: animationDelayRef.current }}
          />
          {message ? (
            <p className="text-sm text-muted-foreground">{message}</p>
          ) : (
            <span className="sr-only">Loading</span>
          )}
        </div>
      </div>
    </div>
  );
}
