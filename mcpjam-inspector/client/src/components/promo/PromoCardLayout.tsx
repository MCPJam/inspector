import type { ReactNode } from "react";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { JamIllustration } from "../billing/JamIllustration";

export function PromoCardLayout({
  children,
  signedIn,
}: {
  children: ReactNode;
  signedIn: boolean;
}) {
  return (
    <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] overflow-y-auto p-6 pt-10 sm:max-w-[480px] sm:p-8 sm:pt-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <img
            src="/mcp_jam_light.png"
            alt="MCPJam"
            className="h-7 w-auto dark:hidden"
          />
          <img
            src="/mcp_jam_dark.png"
            alt="MCPJam"
            className="hidden h-7 w-auto dark:block"
          />
          <p className="mt-4 text-xl font-semibold">1,000 credits. On us.</p>
        </div>
        <div className="shrink-0 [&_img]:w-20">
          <JamIllustration />
        </div>
      </div>
      <DialogHeader className="mt-4 text-left">
        <DialogTitle className="text-2xl font-semibold tracking-tight">
          Claim your credits
        </DialogTitle>
        <DialogDescription className={signedIn ? "sr-only" : "text-base"}>
          {signedIn
            ? "Review your details and credit destination."
            : "Sign in to claim your conference credits."}
        </DialogDescription>
      </DialogHeader>
      {children}
    </DialogContent>
  );
}
