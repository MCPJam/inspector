import { Edit3 } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { TableCell, TableRow } from "../ui/table";

interface OllamaTableRowProps {
  baseUrl: string;
  onEdit: () => void;
}

export function OllamaTableRow({ baseUrl, onEdit }: OllamaTableRowProps) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white p-1 border">
            <img
              src="/ollama_logo.svg"
              alt="Ollama"
              className="w-full h-full object-contain"
            />
          </div>
          <span className="font-medium">Ollama</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant="secondary"
          className="bg-blue-100 text-blue-800 border-blue-200"
        >
          Local
        </Badge>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">{baseUrl}</span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">Local Instance</span>
      </TableCell>
      <TableCell>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Edit3 className="w-4 h-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
