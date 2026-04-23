import type { ReactNode } from "react";
import { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Primary actions (e.g. CTA button); rendered below the description inside the same content block. */
  children?: ReactNode;
  helperText?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  helperText,
  className = "h-[calc(100vh-120px)]",
}: EmptyStateProps) {
  return (
    <div className={`${className} flex items-center justify-center`}>
      <div className="text-center max-w-sm sm:max-w-2xl mx-auto p-4 sm:p-8">
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
          <Icon className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
        <p
          className={`text-sm text-muted-foreground text-pretty ${
            children ? "mb-3" : "mb-4"
          }`}
        >
          {description}
        </p>
        {children ? (
          <div className="flex flex-col items-center gap-2">{children}</div>
        ) : null}
        {helperText ? (
          <p className="text-xs text-muted-foreground text-pretty mt-3">
            {helperText}
          </p>
        ) : null}
      </div>
    </div>
  );
}
