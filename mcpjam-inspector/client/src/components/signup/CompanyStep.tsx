import { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ClockPill } from "@/components/organization/ClockPill";
import type {
  CompanyStepActions,
  ShownCompanyStep,
} from "@/hooks/useWorkOrganizations";

export function workLabel(name: string): string {
  return `${name} (Work)`;
}

export function personalLabel(name: string | null): string {
  return name ? `${name} (Personal)` : "your Personal organization";
}

type Choice = keyof CompanyStepActions;

/**
 * The page after the role question: ask to join the company's Work
 * organization or, as its first signup, learn they own it. Either way the
 * person keeps working in their Personal organization.
 */
export function CompanyStep({
  step,
  personalOrganizationName,
  email,
  userId,
  actions,
  onDone,
}: {
  step: ShownCompanyStep;
  personalOrganizationName: string | null;
  email?: string | null;
  userId?: string | null;
  actions: CompanyStepActions;
  onDone: () => void;
}) {
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState<Choice | null>(null);
  const [failed, setFailed] = useState(false);
  const continueRef = useRef<HTMLButtonElement>(null);
  const work = workLabel(step.name);
  const personal = personalLabel(personalOrganizationName);
  const owner = step.step === "owner";

  useEffect(() => {
    if (requested) continueRef.current?.focus();
  }, [requested]);

  // A failed ask stays here to try again; leaving never waits on the server.
  const choose = async (choice: Choice) => {
    setBusy(choice);
    setFailed(false);
    try {
      await actions[choice]();
      if (choice === "ask") setRequested(true);
    } catch (error) {
      console.error(`[signup] Company step choice failed: ${choice}`, error);
      if (choice === "ask") setFailed(true);
    }
    setBusy(null);
    if (choice === "continue") onDone();
  };

  const stepButton = (
    label: string,
    variant: "default" | "outline" | "ghost",
    choice: Choice,
  ) => (
    <Button
      variant={variant}
      className="w-full"
      disabled={busy !== null}
      onClick={() => void choose(choice)}
    >
      {busy === choice ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {label}
    </Button>
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-6 py-12">
        <div className="mb-10">
          <img src="/mcp_jam.svg" alt="MCPJam" className="mb-8 h-9 w-auto" />
          <h1 className="text-3xl font-semibold tracking-normal">
            {requested
              ? `Request sent to ${work}`
              : owner
                ? `You’re now the owner of ${work}`
                : `Join ${work} on MCPJam?`}
          </h1>
          {owner && !requested ? (
            <p className="mt-3 text-base leading-6 font-semibold text-foreground">
              You’re the first person from {step.domain} to sign up, so you own
              your company’s Work organization. You’re in {personal} for now.
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {requested
                ? "You'll get an email when an owner or admin approves it. Until then you work in your Personal organization."
                : "An owner or admin approves new members of your company's Work organization."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border p-4">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-md bg-info/22 text-base font-semibold text-foreground"
          >
            {step.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 text-sm">
            <span className="block font-bold">{work}</span>
            <span className="text-xs text-muted-foreground">
              Work organization for {step.domain}
            </span>
          </div>
        </div>
        {requested ? (
          <>
            <div className="mt-3">
              <ClockPill>Waiting for approval</ClockPill>
            </div>
            <hr className="my-6 border-border" />
            <Button ref={continueRef} className="w-full" onClick={onDone}>
              <ArrowRight className="h-4 w-4" />
              Continue
            </Button>
          </>
        ) : (
          <>
            <div className="mt-6 grid gap-2" aria-busy={busy !== null}>
              {owner ? (
                stepButton(`Continue to ${personal}`, "ghost", "continue")
              ) : (
                <>
                  {stepButton("Ask to join", "default", "ask")}
                  {stepButton("Continue in Personal", "outline", "continue")}
                </>
              )}
            </div>
            {failed ? (
              <p role="alert" className="mt-2 text-[13px] text-destructive">
                Couldn't send your request. Try again, or continue in Personal
                and ask from Home later.
              </p>
            ) : null}
            {owner ? null : (
              <p className="mt-4 text-xs text-muted-foreground">
                Your projects stay in {personal} either way.
              </p>
            )}
          </>
        )}
        {email ? (
          <p className="mt-6 text-xs text-muted-foreground">
            Signed in as {email}
          </p>
        ) : userId ? (
          <p className="mt-6 text-xs text-muted-foreground">
            Signed in to MCPJam
          </p>
        ) : null}
      </div>
    </main>
  );
}
