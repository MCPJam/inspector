import { Button } from "../ui/button";
import { Edit2, Copy, Trash2 } from "lucide-react";
import type { SavedRequest } from "@/lib/request-types";

interface SavedRequestItemProps {
  request: SavedRequest;
  isHighlighted: boolean;
  onLoad: (request: SavedRequest) => void;
  onRename: (request: SavedRequest) => void;
  onDuplicate: (request: SavedRequest) => void;
  onDelete: (id: string) => void;
}

export function SavedRequestItem({
  request,
  isHighlighted,
  onLoad,
  onRename,
  onDuplicate,
  onDelete,
}: SavedRequestItemProps) {
  return (
    <div
      className={`group p-2 rounded mx-2 cursor-pointer transition-all duration-200 ${
        isHighlighted
          ? "bg-primary/20 border border-primary/30 shadow-sm"
          : "hover:bg-muted/40"
      }`}
      onClick={() => onLoad(request)}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2">
            <code className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border border-border">
              {request.toolName}
            </code>
          </div>
          <div>
            <div className="text-xs font-medium truncate">{request.title}</div>
            {request.description && (
              <div className="text-[10px] text-muted-foreground truncate">
                {request.description}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onRename(request);
            }}
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
          >
            <Edit2 className="w-3 h-3" />
          </Button>
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(request);
            }}
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
          >
            <Copy className="w-3 h-3" />
          </Button>
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(request.id);
            }}
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
