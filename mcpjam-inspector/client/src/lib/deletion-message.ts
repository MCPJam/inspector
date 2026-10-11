/** Backend acknowledgements describe acceptance; only synchronous results are complete. */
export function deletionMessage(result: unknown, completed: string): string {
  return result &&
    typeof result === "object" &&
    "accepted" in result &&
    result.accepted === true
    ? "Deletion started"
    : completed;
}
