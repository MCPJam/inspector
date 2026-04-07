import { type ReactNode, useRef, useEffect, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ArticleShellProps {
  title: string;
  badge: string;
  onBack: () => void;
  onComplete?: () => void;
  children: ReactNode;
}

export function ArticleShell({
  title,
  badge,
  onBack,
  onComplete,
  children,
}: ArticleShellProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const completedRef = useRef(false);

  const handleScroll = useCallback(() => {
    if (completedRef.current || !onComplete) return;
    const el = scrollRef.current;
    if (!el) return;
    // Fire when user is within 40px of the bottom
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      completedRef.current = true;
      onComplete();
    }
  }, [onComplete]);

  // Also check on mount in case content fits without scrolling
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || completedRef.current || !onComplete) return;
    if (el.scrollHeight <= el.clientHeight + 40) {
      completedRef.current = true;
      onComplete();
    }
  }, [onComplete]);

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
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
      >
        {children}
      </div>
    </div>
  );
}
