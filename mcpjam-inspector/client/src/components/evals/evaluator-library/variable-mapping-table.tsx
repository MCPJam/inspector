import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";

/** A judge prompt variable and the iteration field that fills it. */
export type PromptVariable = {
  /** Name used in the prompt, without braces: `tool_results`. */
  name: string;
  /** Description or path of the source field. */
  path: string;
  /** The value in the iteration picked for preview, already truncated. */
  preview?: string;
};

export type VariableMappingTableProps = {
  variables: readonly PromptVariable[];
  /** Every path a variable may come from. */
  paths?: readonly string[];
  /** Label for the preview column, e.g. "Iteration #3". */
  previewLabel?: string;
  onPathChange?: (name: string, path: string) => void;
};

/**
 * Shows where each prompt variable comes from and what it holds in a real
 * iteration, so the author sees exactly what the judge will read before
 * saving instead of after a run.
 */
export function VariableMappingTable({
  variables,
  paths,
  previewLabel,
  onPathChange,
}: VariableMappingTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Variable</TableHead>
            <TableHead>Comes from</TableHead>
            {paths ? (
              <TableHead>
                {previewLabel ? `Value in ${previewLabel}` : "Value"}
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {variables.map((variable) => (
            <TableRow key={variable.name}>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {`{{${variable.name}}}`}
                </code>
              </TableCell>
              <TableCell>
                {paths && onPathChange ? (
                  <Select
                    value={variable.path}
                    onValueChange={(path) => onPathChange(variable.name, path)}
                  >
                    <SelectTrigger
                      aria-label={`Source for ${variable.name}`}
                      className="h-8 w-64 font-mono text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {paths.map((path) => (
                        <SelectItem
                          key={path}
                          value={path}
                          className="font-mono text-xs"
                        >
                          {path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  variable.path
                )}
              </TableCell>
              {paths ? (
                <TableCell className="max-w-72 truncate font-mono text-xs text-muted-foreground">
                  {variable.preview ?? "No preview iteration"}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
