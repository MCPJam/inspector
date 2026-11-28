import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";

export type PromptVariable = {
  /** Name used in the prompt, without braces: `tool_results`. */
  name: string;
  description: string;
};

export function VariableMappingTable({
  variables,
}: {
  variables: readonly PromptVariable[];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Variable</TableHead>
            <TableHead>Comes from</TableHead>
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
              <TableCell className="whitespace-normal">
                {variable.description}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
