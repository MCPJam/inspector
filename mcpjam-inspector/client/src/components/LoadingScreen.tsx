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
        <div
          className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 border-t-primary mx-auto"
          style={{ animationDelay: animationDelayRef.current }}
        ></div>
        {message ? (
          <p className="text-sm text-muted-foreground">{message}</p>
        ) : null}
      </div>
    </div>
  );
}
