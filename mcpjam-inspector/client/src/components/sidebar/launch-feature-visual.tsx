import {
  Check,
  GitBranch,
  MessageSquare,
  Star,
  ArrowRight,
} from "lucide-react";
import { SwarmHeroCharacters } from "../swarms/swarm-hero-characters";

export type LaunchFeatureId = "swarms" | "user-testing" | "evals" | "ci-cd";

const LABELS: Record<LaunchFeatureId, string> = {
  swarms: "Swarm characters explore parallel user journeys across clients",
  "user-testing":
    "A user tests a conversation and leaves a rating and feedback",
  evals: "An evaluation suite tracks improving results across repeated runs",
  "ci-cd": "A pull request passes automated checks before release",
};

/** Illustrative product previews, kept in theme and distinct from live results. */
export function LaunchFeatureVisual({ feature }: { feature: LaunchFeatureId }) {
  return (
    <div
      role="img"
      aria-label={LABELS[feature]}
      className="flex h-72 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/50 p-5 sm:h-80 sm:p-8"
    >
      <div aria-hidden className="w-full max-w-md">
        {feature === "swarms" && (
          <div className="space-y-5 text-center">
            <SwarmHeroCharacters className="gap-5 sm:gap-8" />
            <svg
              viewBox="0 0 360 40"
              className="mx-auto h-10 w-full max-w-sm text-primary"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M50 0v10q0 10 10 10h240q10 0 10-10V0M135 0v20M225 0v20M180 20v20"
                strokeDasharray="4 4"
              />
            </svg>
            <div className="grid grid-cols-3 gap-2">
              {["ChatGPT", "Claude", "Cursor"].map((name) => (
                <div
                  key={name}
                  className="rounded-lg border border-border bg-background py-3 text-xs font-medium"
                >
                  {name}
                  <div className="mx-auto mt-2 h-1 w-8 rounded bg-primary/40" />
                </div>
              ))}
            </div>
            <p className="text-xs text-foreground">
              Different users. Different clients. One swarm.
            </p>
          </div>
        )}
        {feature === "user-testing" && (
          <div className="space-y-3">
            <div className="ml-10 rounded-lg rounded-br-none border border-border bg-background p-3 text-sm">
              Can you help me find the right plan?
            </div>
            <div className="mr-6 flex gap-3 rounded-lg rounded-bl-none border border-border bg-background p-4">
              <MessageSquare className="mt-1 size-5 shrink-0 text-primary" />
              <div className="flex-1 space-y-2">
                <div className="h-2 w-4/5 rounded bg-foreground/20" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-3/5 rounded bg-foreground/10" />
              </div>
            </div>
            <div className="ml-8 rounded-lg border border-border bg-background p-4">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium">
                Real user feedback
                <span className="flex gap-0.5">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star
                      key={i}
                      className="size-3 fill-primary/20 text-primary"
                    />
                  ))}
                </span>
              </div>
              <p className="text-sm">“That’s exactly what I needed.”</p>
            </div>
          </div>
        )}
        {feature === "evals" && (
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center justify-between text-xs font-medium">
              <span>Suite health</span>
              <span className="flex items-center gap-1">
                <Check className="size-3 text-success" />
                Improving
              </span>
            </div>
            <svg viewBox="0 0 360 120" className="my-4 h-28 w-full" fill="none">
              {[30, 60, 90].map((y) => (
                <path
                  key={y}
                  d={`M0 ${y}H360`}
                  className="stroke-border"
                  strokeDasharray="3 5"
                />
              ))}
              <path
                d="M8 102L62 84L120 92L177 51L234 60L292 28L352 12"
                className="stroke-primary"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {[
                [8, 102],
                [62, 84],
                [120, 92],
                [177, 51],
                [234, 60],
                [292, 28],
                [352, 12],
              ].map(([cx, cy]) => (
                <circle
                  key={cx}
                  cx={cx}
                  cy={cy}
                  r="4"
                  className="fill-background stroke-primary"
                  strokeWidth="2"
                />
              ))}
            </svg>
            <div className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
              {["Tool selection", "Task completion", "Response quality"].map(
                (label) => (
                  <div key={label} className="flex flex-col gap-1">
                    <Check className="size-4 text-success" />
                    {label}
                  </div>
                ),
              )}
            </div>
          </div>
        )}
        {feature === "ci-cd" && (
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="mb-4 flex items-center gap-2 border-b border-border pb-3 text-sm font-medium">
              <GitBranch className="size-4 text-primary" />
              Ready for the next release
            </div>
            {[
              "Protocol conformance",
              "OAuth & security",
              "Cross-client evals",
            ].map((label) => (
              <div key={label} className="flex items-center gap-2 py-2 text-xs">
                <Check className="size-4 text-success" />
                <span className="flex-1">{label}</span>
                <span>Passed</span>
              </div>
            ))}
            <div className="mt-3 flex items-center justify-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs font-medium">
              Commit
              <ArrowRight className="size-3" />
              Check
              <ArrowRight className="size-3" />
              Ship
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
