import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ArticleShellProps {
  title: string;
  badge: string;
  onBack: () => void;
  children: ReactNode;
}

export function ArticleShell({
  title,
  badge,
  onBack,
  children,
}: ArticleShellProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          title="Back to Learning"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5 shrink-0">
          {badge}
        </Badge>
      </div>

      {/* Full-width scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {children}
      </div>
    </div>
  );
}
