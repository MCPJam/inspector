import { cn } from "../cn";
import { Skeleton } from "./skeleton";

interface ServersLoadingSkeletonProps extends React.ComponentProps<"div"> {
  cardClassName?: string;
  cardCount?: number;
  gridClassName?: string;
}

function ServersLoadingSkeleton({
  cardClassName,
  cardCount = 16,
  className,
  gridClassName,
  ...props
}: ServersLoadingSkeletonProps) {
  return (
    <div
      data-slot="servers-loading-skeleton"
      data-testid="servers-loading-skeleton"
      className={cn("flex-1 overflow-hidden p-6", className)}
      {...props}
    >
      <div
        className={cn(
          "grid grid-cols-1 gap-6 lg:grid-cols-1 xl:grid-cols-2",
          gridClassName,
        )}
      >
        {Array.from({ length: cardCount }).map((_, index) => (
          <Skeleton
            key={index}
            className={cn("h-24 w-full rounded-xl", cardClassName)}
          />
        ))}
      </div>
    </div>
  );
}

export { ServersLoadingSkeleton };
