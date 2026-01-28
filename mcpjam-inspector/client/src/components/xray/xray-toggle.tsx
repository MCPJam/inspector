/**
 * X-Ray Toggle Component
 *
 * A button that opens the X-Ray panel in a sheet/drawer to inspect AI requests.
 * Subscribes to X-Ray SSE stream when mounted so events are captured even when panel is closed.
 */

import { useState, useEffect } from "react";
import { Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { XRayPanel } from "./xray-panel";
import {
  useTrafficLogStore,
  subscribeToXRayStream,
} from "@/stores/traffic-log-store";

export function XRayToggle() {
  const [open, setOpen] = useState(false);
  const xrayItemCount = useTrafficLogStore((s) => s.xrayItems.length);

  // Subscribe to X-Ray stream when component mounts (always active in header)
  useEffect(() => {
    console.log("[XRayToggle] Mounting, subscribing to X-Ray stream");
    const unsubscribe = subscribeToXRayStream();
    return () => {
      console.log("[XRayToggle] Unmounting, unsubscribing from X-Ray stream");
      unsubscribe();
    };
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1.5 relative"
            >
              <Scan className="h-4 w-4" />
              <span className="hidden sm:inline text-xs">X-Ray</span>
              {xrayItemCount > 0 && (
                <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] font-medium bg-cyan-500 text-white rounded-full flex items-center justify-center">
                  {xrayItemCount > 99 ? "99+" : xrayItemCount}
                </span>
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>X-Ray: Inspect AI requests</p>
        </TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="w-[500px] sm:w-[600px] p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>X-Ray - AI Request Inspector</SheetTitle>
        </SheetHeader>
        <XRayPanel onClose={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
