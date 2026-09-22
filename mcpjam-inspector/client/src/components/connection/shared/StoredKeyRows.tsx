import { Input } from "@mcpjam/design-system/input";
import { MaskedValueInput } from "./MaskedValueInput";

interface StoredKeyRowsProps {
  /** Names of the stored entries, in the order the server returned them. */
  keys: string[];
  /** Sits between name and value: "=" for env vars, ":" for headers. */
  separator: string;
  /** e.g. "Environment variable" — the row labels read "<noun> 1 name". */
  rowNoun: string;
  isRevealing?: boolean;
  error?: string | null;
  /** Asks for this row's value. Fetches the whole set, so the caller decides
   * what to uncover once it lands. */
  onReveal?: (key: string) => void;
}

/**
 * The rows of a server whose values are still on the server: name readable,
 * value masked, an eye each.
 *
 * A stored set used to be one anonymous mask, which answered nothing — not
 * which variables were set, not even how many. Naming them is not a secret
 * (`fetchServerSecretKeys` brings names without values), and it splits the two
 * questions the section is asked: *what is configured* is answered by opening
 * it, *what is this one's value* by the eye on its row.
 *
 * Names are all these rows have, so they don't join the form: nothing here is
 * editable and removing needs a reveal first. Otherwise saving a form whose
 * rows are name-only would write empty values over the stored secrets.
 */
export function StoredKeyRows({
  keys,
  separator,
  rowNoun,
  isRevealing = false,
  error,
  onReveal,
}: StoredKeyRowsProps) {
  return (
    <div className="space-y-1.5">
      {/* -mx-1/px-1 keeps focus rings from being clipped by the scroller. */}
      <div className="-mx-1 max-h-52 space-y-1.5 overflow-y-auto px-1">
        {keys.map((key, index) => (
          <div key={key} className="flex items-center gap-1.5">
            <Input
              value={key}
              readOnly
              aria-readonly
              spellCheck={false}
              aria-label={`${rowNoun} ${index + 1} name`}
              className="h-8 flex-1 font-mono text-xs"
            />
            <span
              aria-hidden="true"
              className="shrink-0 select-none text-xs text-muted-foreground/70"
            >
              {separator}
            </span>
            <MaskedValueInput
              value=""
              onChange={() => {}}
              visible={false}
              pendingReveal
              isRevealing={isRevealing}
              onToggleVisibility={() => onReveal?.(key)}
              inputLabel={`${rowNoun} ${index + 1} value`}
              subject={key}
              className="flex-[1.4]"
            />
            {/* Spacer matching the remove button on an editable row, so the
                masked rows don't shift sideways when the reveal lands. */}
            <div aria-hidden="true" className="h-8 w-8 shrink-0" />
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
