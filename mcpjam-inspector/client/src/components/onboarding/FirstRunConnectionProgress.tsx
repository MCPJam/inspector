/**
 * Connection progress for first-run onboarding. The vertical list runs while
 * MCPJam connects; the inline strip sits under the sign-in step.
 */
import { Check, Circle, Loader2, LockKeyhole } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";

export const CONNECTION_PROGRESS_STEPS = [
  "Reach the server",
  "Complete the MCP handshake",
  "Load tools",
] as const;

export function ConnectionProgress({
  status,
  prefersReducedMotion,
  completedSteps,
}: {
  status: "preparing" | "connecting" | "loading-tools" | "connected";
  prefersReducedMotion: boolean | null;
  completedSteps: number;
}) {
  const completedThrough = Math.max(
    completedSteps - 1,
    status === "loading-tools" ? 1 : -1,
  );
  const activeIndex = completedThrough >= 2 ? -1 : completedThrough + 1;

  return (
    <ol
      aria-label="Connection progress"
      className="mt-8 divide-y divide-border rounded-lg border border-border bg-card px-5"
    >
      {CONNECTION_PROGRESS_STEPS.map((label, index) => {
        const isComplete = index <= completedThrough;
        const isActive = index === activeIndex;
        return (
          <li
            key={label}
            aria-current={isActive ? "step" : undefined}
            className="flex items-center gap-3 py-3.5"
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {isComplete ? (
                <Check
                  className="size-4.5 text-success"
                  strokeWidth={2.25}
                  aria-hidden
                />
              ) : isActive ? (
                <Loader2
                  className={cn(
                    "size-4.5 text-primary",
                    !prefersReducedMotion && "animate-spin",
                  )}
                  aria-hidden
                />
              ) : (
                <Circle className="size-3.5 text-input" aria-hidden />
              )}
            </span>
            <span
              className={cn(
                "text-base",
                isComplete || isActive
                  ? "text-foreground"
                  : "text-muted-foreground",
                isActive && "font-medium",
              )}
            >
              {label}
            </span>
            <span className="ml-auto text-sm text-muted-foreground">
              {isComplete ? "Done" : isActive ? "In progress" : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const AUTHORIZATION_STEPS = [
  { label: "Reached the server", state: "done" },
  { label: "Sign in", state: "current" },
  { label: "Handshake", state: "pending" },
  { label: "Load tools", state: "pending" },
] as const;

export function AuthorizationProgress() {
  return (
    <ol
      aria-label="Connection progress"
      className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm"
    >
      {AUTHORIZATION_STEPS.map(({ label, state }) => (
        <li
          key={label}
          aria-current={state === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-2",
            state === "done" && "text-foreground",
            state === "current" && "font-medium text-foreground",
            state === "pending" && "text-muted-foreground",
          )}
        >
          {state === "done" ? (
            <Check
              className="size-4 text-success"
              strokeWidth={2.5}
              aria-hidden
            />
          ) : state === "current" ? (
            <LockKeyhole className="size-4 text-primary" aria-hidden />
          ) : (
            <Circle className="size-3.5 text-input" aria-hidden />
          )}
          {label}
        </li>
      ))}
    </ol>
  );
}
