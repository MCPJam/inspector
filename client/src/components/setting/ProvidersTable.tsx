import { ProviderTableRow } from "./ProviderTableRow";
import { OllamaTableRow } from "./OllamaTableRow";
import { LiteLLMTableRow } from "./LiteLLMTableRow";

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
  litellmBaseUrl: string;
  litellmModelAlias: string;
  onEditLiteLLM: () => void;
}

export function ProvidersTable({
  providerConfigs,
  hasToken,
  onEditProvider,
  onDeleteProvider,
  ollamaBaseUrl,
  onEditOllama,
  litellmBaseUrl,
  litellmModelAlias,
  onEditLiteLLM,
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
      <LiteLLMTableRow
        baseUrl={litellmBaseUrl}
        modelAlias={litellmModelAlias}
        onEdit={onEditLiteLLM}
      />
    </div>
  );
}
