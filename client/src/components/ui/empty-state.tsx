import { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  helperText?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  helperText,
  className = "",
}: EmptyStateProps) {
  return (
    <div className={`flex-1 flex items-center justify-center min-h-0 ${className}`}>
      <div className="text-center max-w-sm sm:max-w-2xl mx-auto p-6 sm:p-8">
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
          <Icon className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
          {description}
        </p>
        {helperText && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {helperText}
          </p>
        )}
      </div>
    </div>
  );
}
