import { Button } from "@mcpjam/design-system/button";
import type { Predicate } from "@mcpjam/sdk/predicates";

type SchemaPredicate = Extract<Predicate, { type: "toolResultMatchesSchema" }>;

/**
 * The editor for `toolResultMatchesSchema` when it reads each tool's own
 * declared output schema. There is nothing to author, so it says what is
 * checked and offers to switch to a written schema instead.
 */
export function DeclaredSchemaFields({
  predicate,
  onChange,
  readOnly,
}: {
  predicate: SchemaPredicate;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        Each result&apos;s structuredContent is checked against the output
        schema its tool declares. Error results and tools without an output
        schema are skipped.
      </p>
      {readOnly ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange({ ...predicate, schema: {} })}
        >
          Write a schema instead
        </Button>
      )}
    </div>
  );
}
