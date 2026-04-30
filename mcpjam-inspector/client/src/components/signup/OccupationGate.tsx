import { FormEvent, useState } from "react";
import { useMutation } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { standardEventProps } from "@/lib/PosthogUtils";
import { cn } from "@/lib/utils";

const OCCUPATION_SUGGESTIONS = [
  "Software Engineer",
  "Product Manager",
  "Engineering Manager",
  "Platform Engineer",
  "Other",
];

interface OccupationGateProps {
  userId?: string | null;
  email?: string | null;
}

export function OccupationGate({ userId, email }: OccupationGateProps) {
  const posthog = usePostHog();
  const updateOccupation = useMutation("users:updateOccupation" as any);
  const [occupation, setOccupation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const trimmedOccupation = occupation.trim();
  const canSubmit = trimmedOccupation.length > 0 && !isSubmitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedOccupation) {
      setError("Enter your role to continue.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await updateOccupation({ occupation: trimmedOccupation });
      posthog.setPersonProperties({ occupation: trimmedOccupation });
      posthog.capture("signup_occupation_submitted", {
        ...standardEventProps("signup_occupation_gate"),
        occupation: trimmedOccupation,
      });
      posthog.register({ occupation: trimmedOccupation });
    } catch (err) {
      console.error("[signup] Failed to save occupation", err);
      setError("Could not save your occupation. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-6 py-12">
        <div className="mb-10">
          <img src="/mcp_jam.svg" alt="MCPJam" className="mb-8 h-9 w-auto" />
          <h1 className="text-3xl font-semibold tracking-normal">
            What is your role?
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            This helps us understand who is using MCPJam.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <Input
            value={occupation}
            onChange={(event) => {
              setOccupation(event.target.value);
              if (error) setError(null);
            }}
            placeholder="Type your role"
            autoComplete="organization-title"
            className="mb-4 h-11 text-base md:text-sm"
            autoFocus
          />

          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Suggestions
          </p>

          <div className="flex flex-wrap gap-2">
            {OCCUPATION_SUGGESTIONS.map((suggestion) => {
              const isSelected =
                occupation.trim().toLowerCase() === suggestion.toLowerCase();
              return (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setOccupation(suggestion);
                    if (error) setError(null);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-all duration-150",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground shadow-sm"
                      : "border-border bg-background text-foreground hover:-translate-y-px hover:border-primary hover:bg-primary hover:text-primary-foreground hover:shadow-md",
                  )}
                >
                  {isSelected && <Check className="h-3.5 w-3.5" />}
                  {suggestion}
                </button>
              );
            })}
          </div>

          {error ? (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          ) : null}

          <hr className="my-6 border-border" />

          <Button type="submit" disabled={!canSubmit} className="w-full">
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            Continue
          </Button>
        </form>

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
