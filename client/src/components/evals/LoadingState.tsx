import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface LoadingStateProps {
  title?: string;
  description?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-12 w-12",
} as const;

export function LoadingState({
  title = "Loading...",
  description,
  className,
  size = "md",
}: LoadingStateProps) {
  return (
    <div className={cn("flex items-center justify-center p-6", className)}>
      <div className="text-center">
        <Loader2
          className={cn("mx-auto animate-spin text-primary", sizeMap[size])}
        />
        {title && <p className="mt-4 font-medium text-foreground">{title}</p>}
        {description && (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Inline loading spinner for smaller contexts
 */
export function LoadingSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} />;
}

/**
 * Full page loading state
 */
export function FullPageLoading({
  title = "Loading...",
  description,
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="flex h-screen items-center justify-center">
      <LoadingState title={title} description={description} size="lg" />
    </div>
  );
}
