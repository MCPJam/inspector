import { Card } from "../ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { ProviderTableRow } from "./ProviderTableRow";
import { OllamaTableRow } from "./OllamaTableRow";

interface ProviderConfig {
  id: string;
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  placeholder: string;
  getApiKeyUrl: string;
}

interface ProvidersTableProps {
  providerConfigs: ProviderConfig[];
  hasToken: (providerId: string) => boolean;
  getToken: (providerId: string) => string;
  getCreatedDate: (providerId: string) => string;
  maskApiKey: (key: string) => string;
  onEditProvider: (providerId: string) => void;
  onDeleteProvider: (providerId: string) => void;
  ollamaBaseUrl: string;
  onEditOllama: () => void;
}

export function ProvidersTable({
  providerConfigs,
  hasToken,
  getToken,
  getCreatedDate,
  maskApiKey,
  onEditProvider,
  onDeleteProvider,
  ollamaBaseUrl,
  onEditOllama,
}: ProvidersTableProps) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Configured</TableHead>
            <TableHead>API Key</TableHead>
            <TableHead>Created at</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providerConfigs.map((config) => {
            const isConfigured = hasToken(config.id);
            const apiKeyValue = getToken(config.id);

            return (
              <ProviderTableRow
                key={config.id}
                config={config}
                isConfigured={isConfigured}
                apiKeyValue={apiKeyValue}
                createdDate={getCreatedDate(config.id)}
                onEdit={onEditProvider}
                onDelete={onDeleteProvider}
                maskApiKey={maskApiKey}
              />
            );
          })}
          <OllamaTableRow baseUrl={ollamaBaseUrl} onEdit={onEditOllama} />
        </TableBody>
      </Table>
    </Card>
  );
}
