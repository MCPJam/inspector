import { cn } from "../cn";
import { Skeleton } from "./skeleton";

interface ServersLoadingSkeletonProps extends React.ComponentProps<"div"> {
  cardClassName?: string;
  cardCount?: number;
  gridClassName?: string;
}

function ServersLoadingSkeleton({
  cardClassName,
  cardCount = 2,
  className,
  gridClassName,
  ...props
}: ServersLoadingSkeletonProps) {
  return (
    <div
      data-slot="servers-loading-skeleton"
      className={cn("flex-1 p-6", className)}
      {...props}
    >
      <div
        className={cn("grid grid-cols-1 gap-6 xl:grid-cols-2", gridClassName)}
      >
        {Array.from({ length: cardCount }).map((_, index) => (
          <Skeleton
            key={index}
            className={cn("h-48 w-full rounded-lg", cardClassName)}
          />
        ))}
      </div>
    </div>
  );
}

export { ServersLoadingSkeleton };
