import type { ReactNode } from "react";
import { Check, ShieldCheck } from "lucide-react";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import jamJar from "../../../../../docs/images/okta/mcpjam-jar.png";

export function PromoCardLayout({ children }: { children: ReactNode }) {
  return (
    <DialogContent className="max-h-[92dvh] w-[calc(100%_-_2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[900px]">
      <div className="grid md:grid-cols-[0.95fr_1.05fr]">
        <ConferenceCard />
        <section className="flex flex-col bg-card px-6 py-8 text-card-foreground sm:px-9 md:py-10">
          <DialogHeader className="mb-7 text-left">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Your conference card
            </p>
            <DialogTitle className="text-3xl font-semibold tracking-tight">
              Claim your credits
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm leading-relaxed">
              Confirm your details and choose where your credits go.
            </DialogDescription>
          </DialogHeader>
          {children}
          <div className="mt-6 flex items-start gap-2 border-t border-border pt-5 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Details are used for conference attribution and individual
              follow-up. You won’t be subscribed to a newsletter.
            </p>
          </div>
        </section>
      </div>
    </DialogContent>
  );
}

function ConferenceCard() {
  return (
    <aside className="flex flex-col border-b border-border bg-background px-6 py-7 text-foreground sm:px-9 md:border-b-0 md:border-r md:py-10">
      <div className="mb-8">
        <img
          src="/mcp_jam_light.png"
          alt="MCPJam"
          className="h-6 w-auto dark:hidden"
        />
        <img
          src="/mcp_jam_dark.png"
          alt="MCPJam"
          className="hidden h-6 w-auto dark:block"
        />
      </div>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        AGNTCon · Conference credits
      </p>
      <h2 className="max-w-xs text-3xl font-semibold leading-[1.08] tracking-tight md:text-[42px]">
        Your next MCP build starts here.
      </h2>
      <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
        A little jam for your next idea. Connect, test, and build with MCPJam.
      </p>
      <div className="my-7 flex items-center gap-4 border-y border-border py-5 md:my-8 md:flex-col md:items-start">
        <img
          src={jamJar}
          alt="Pixel-art MCPJam jar"
          className="size-20 object-contain md:mx-auto md:mb-3 md:size-40"
        />
        <div>
          <p className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight md:text-5xl">
              1,000
            </span>
            <span className="text-sm text-muted-foreground">credits</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Yours to use. Redeemed credits never expire.
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-4 text-foreground" aria-hidden />
        No credit card needed
      </div>
    </aside>
  );
}
