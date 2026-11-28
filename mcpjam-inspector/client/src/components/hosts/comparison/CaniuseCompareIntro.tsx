import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { useAnnouncementSlot } from "@/components/announcement-slot";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { clientLogo } from "./CaniuseSite";

const PROMPTS = [
  { name: "elicitation", clients: ["preset:claude", "preset:cursor"] },
  { name: "MCP Apps", clients: ["preset:chatgpt", "preset:claude"] },
  { name: "Events", clients: ["preset:codex", "preset:chatgpt"] },
];
let introSeen = false;

export function CaniuseCompareIntro({
  eligible,
  subjects,
  children,
}: {
  eligible: boolean;
  subjects: Readonly<Record<string, HostComparisonSubject>>;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState(() => (eligible && !introSeen ? 0 : null));
  const slot = useAnnouncementSlot(eligible && !reduceMotion && step !== null);
  const prompt = slot.open && step !== null ? PROMPTS[step] : null;

  useEffect(() => {
    if (!slot.open || step === null) return;
    introSeen = true;
    const timer = window.setTimeout(() => {
      setStep(step + 1 < PROMPTS.length ? step + 1 : null);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [slot.open, step]);

  return (
    <div className="relative h-full min-w-0" onFocusCapture={() => setStep(null)}>
      {children}
      {prompt && (
        <div
          ref={slot.contentRef}
          aria-hidden="true"
          className="caniuse-intro absolute inset-0 z-[60]"
          onPointerDown={() => setStep(null)}
        >
          <div className="caniuse-wrap pt-24 sm:pt-36">
            <div className="caniuse-hero flex flex-wrap items-baseline gap-x-[0.23em] gap-y-1 font-bold">
              <span className="caniuse-reveal">Can I use</span>
              <span
                key={step}
                className="caniuse-prompt inline-flex min-w-0 flex-wrap items-center gap-x-[0.21em] gap-y-1"
              >
                <span className="text-primary">{prompt.name}</span> in
                {prompt.clients.map((id) => {
                  const subject = subjects[id];
                  return subject && (
                    <img
                      key={id}
                      src={clientLogo(subject)}
                      alt=""
                      className="size-11 rounded-lg border border-border bg-card p-1.5 object-contain sm:size-14"
                    />
                  );
                })}
                ?
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
