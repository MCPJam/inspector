import { ProviderTableRow } from "./ProviderTableRow";
import { OpenRouterTableRow } from "./OpenRouterTableRow";
import { OllamaTableRow } from "./OllamaTableRow";
import { AzureOpenAITableRow } from "./AzureOpenAITableRow";

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
  onEditProvider: (providerId: string) => void;
  onDeleteProvider: (providerId: string) => void;
  ollamaBaseUrl: string;
  onEditOllama: () => void;
  openRouterSelectedModels: string[];
  onEditOpenRouter: () => void;
  azureBaseUrl: string;
  onEditAzure: () => void;
}

export function ProvidersTable({
  providerConfigs,
  hasToken,
  onEditProvider,
  onDeleteProvider,
  ollamaBaseUrl,
  onEditOllama,
  openRouterSelectedModels,
  onEditOpenRouter,
  azureBaseUrl,
  onEditAzure,
}: ProvidersTableProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {providerConfigs.map((config) => {
        const isConfigured = hasToken(config.id);
        return (
          <ProviderTableRow
            key={config.id}
            config={config}
            isConfigured={isConfigured}
            onEdit={onEditProvider}
            onDelete={onDeleteProvider}
          />
        );
      })}
      <OllamaTableRow baseUrl={ollamaBaseUrl} onEdit={onEditOllama} />
      <OpenRouterTableRow
        modelAlias={openRouterSelectedModels}
        onEdit={onEditOpenRouter}
        onDelete={() => onDeleteProvider("openrouter")}
      />
      <AzureOpenAITableRow baseUrl={azureBaseUrl} onEdit={onEditAzure} />
    </div>
  );
}
