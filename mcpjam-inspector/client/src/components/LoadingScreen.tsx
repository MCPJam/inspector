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

export default function LoadingScreen() {
  const animationDelayRef = useRef(getSpinnerAnimationDelay());

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center">
        <div
          className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 border-t-primary mx-auto"
          style={{ animationDelay: animationDelayRef.current }}
        ></div>
      </div>
    </div>
  );
}
