import { Component, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";

export class ProjectSecretsBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const needsSignIn = error.message.includes("Authenticated user required");
    return (
      <section className="space-y-3" aria-label="Environment variables">
        <h1 className="text-2xl font-semibold">Environment variables</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {needsSignIn
            ? "We couldn’t verify your session. Retry, or sign in again to access environment variables."
            : "Environment variables couldn’t be loaded. Please try again."}
        </p>
        <Button
          variant="outline"
          onClick={() => this.setState({ error: null })}
        >
          Retry
        </Button>
      </section>
    );
  }
}
