import { codeLine, isCodeChange, type RoundChange } from "./round-model";

const show = (value: unknown): string =>
  value === undefined ? "Not set" : typeof value === "string" ? value : JSON.stringify(value);

/** What the round changed on the mock, as before and after, or the one line a code round shows. */
export function ChangeDisclosure({ changes }: { changes: RoundChange | undefined }) {
  if (isCodeChange(changes)) {
    return (
      <p className="text-sm">
        {codeLine(changes)}. This round's change is the code that server runs, so there is no before and after to show.
      </p>
    );
  }
  if (changes === undefined) {
    return <p className="text-sm text-muted-foreground">Loading the change.</p>;
  }
  if (changes === null || changes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {changes === null
          ? "The change could not be read. Reload the page to try again."
          : "This round submitted the best so far unchanged."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {changes.flatMap((change) =>
        change.details.map((detail) => (
          <div key={`${change.name ?? "server"}:${detail.path}`} className="flex flex-col gap-1.5">
            <p className="text-sm">{detail.summary}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  ["Before", detail.before],
                  ["After", detail.after],
                ] as const
              ).map(([name, value]) => (
                <div key={name} className="rounded-md border border-border bg-code-bg p-3">
                  <div className="mb-1 text-xs text-muted-foreground">{name}</div>
                  <code className="break-words text-xs">{show(value)}</code>
                </div>
              ))}
            </div>
          </div>
        )),
      )}
    </div>
  );
}
