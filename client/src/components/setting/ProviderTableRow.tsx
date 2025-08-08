import { Edit3, Trash2, Plus, Check, X } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { TableCell, TableRow } from "../ui/table";

interface ProviderConfig {
  id: string;
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  placeholder: string;
  getApiKeyUrl: string;
}

interface ProviderTableRowProps {
  config: ProviderConfig;
  isConfigured: boolean;
  apiKeyValue: string;
  createdDate: string;
  onEdit: (providerId: string) => void;
  onDelete: (providerId: string) => void;
  maskApiKey: (key: string) => string;
}

export function ProviderTableRow({
  config,
  isConfigured,
  apiKeyValue,
  createdDate,
  onEdit,
  onDelete,
  maskApiKey,
}: ProviderTableRowProps) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white p-1 border">
            <img
              src={config.logo}
              alt={config.logoAlt}
              className="w-full h-full object-contain"
            />
          </div>
          <span className="font-medium">{config.name}</span>
        </div>
      </TableCell>
      <TableCell>
        {isConfigured ? (
          <Badge
            variant="secondary"
            className="bg-green-100 text-green-800 border-green-200"
          >
            <Check className="w-3 h-3 mr-1" />
            Configured
          </Badge>
        ) : (
          <Badge
            variant="secondary"
            className="bg-red-100 text-red-800 border-red-200"
          >
            <X className="w-3 h-3 mr-1" />
            Not Configured
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <span className="font-mono text-sm">
          {isConfigured ? maskApiKey(apiKeyValue) : "N/A"}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">{createdDate}</span>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          {isConfigured ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onEdit(config.id)}
              >
                <Edit3 className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(config.id)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onEdit(config.id)}>
              <Plus className="w-4 h-4" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
