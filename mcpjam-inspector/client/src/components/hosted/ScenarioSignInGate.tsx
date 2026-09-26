import { LockKeyhole } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

export function ScenarioSignInGate({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <section
        className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center"
        aria-labelledby="scenario-sign-in-title"
      >
        <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted text-foreground">
          <LockKeyhole className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="mb-3 text-xs font-medium uppercase tracking-widest text-foreground">
          User testing
        </p>
        <h1
          id="scenario-sign-in-title"
          className="text-2xl font-semibold tracking-tight text-card-foreground"
        >
          Sign in to preview this study
        </h1>
        <p className="mt-4 text-sm leading-6 text-foreground">
          Sign in or create an account to view the study and take part in the
          test.
        </p>
        <div className="mt-7 flex flex-col gap-3">
          <Button size="lg" onClick={onSignIn}>
            Sign in
          </Button>
          <Button size="lg" variant="outline" onClick={onSignUp}>
            Create an account
          </Button>
        </div>
        <p className="mt-6 text-xs leading-5 text-foreground">
          You’ll return to this link after signing in. Previewing won’t start a
          test.
        </p>
      </section>
    </div>
  );
}
