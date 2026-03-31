export function getSandboxOAuthRowCopy(status: string): {
  description: string;
  buttonLabel: string | null;
} {
  switch (status) {
    case "launching":
      return {
        description: "Opening consent screen…",
        buttonLabel: null,
      };
    case "resuming":
      return {
        description: "Finishing authorization…",
        buttonLabel: null,
      };
    case "verifying":
      return {
        description: "Verifying access…",
        buttonLabel: null,
      };
    case "error":
      return {
        description: "Authorization could not be completed. Try again.",
        buttonLabel: "Authorize again",
      };
    case "needs_auth":
    default:
      return {
        description: "You'll return here automatically after consent.",
        buttonLabel: "Authorize",
      };
  }
}
