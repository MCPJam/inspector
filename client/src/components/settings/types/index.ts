import { SupportedProvider } from "@/lib/providers";

export interface SettingsTabProps {
  disabled?: boolean;
}

export interface ProviderData {
  key: string; // For API keys (Anthropic, OpenAI) or host URL (Ollama)
  isValid: boolean;
  showKey: boolean;
}

export interface ProvidersState {
  anthropic: ProviderData;
  openai: ProviderData;
  ollama: ProviderData;
}

export interface ProviderConfig {
  name: SupportedProvider;
  displayName: string;
  placeholder: string;
  description: string;
  logo: string;
}
