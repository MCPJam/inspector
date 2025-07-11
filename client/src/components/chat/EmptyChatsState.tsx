import React from "react";
import { ProviderLogo } from "../ProviderLogo";
import { SupportedProvider } from "@/lib/providers";
import { OllamaSetupGuide } from "./OllamaSetupGuide";

// Config for different chat modes
interface ChatConfig {
  title: string;
  subtitle?: string;
  suggestions: string[];
  showToolsCount?: boolean;
  showServersCount?: boolean;
}

interface EmptyChatsStateProps {
  onSuggestionClick: (suggestion: string) => void;
  selectedProvider: SupportedProvider;
  config: ChatConfig;
  toolsCount?: number;
  serversCount?: number;
}

export const EmptyChatsState: React.FC<EmptyChatsStateProps> = ({
  onSuggestionClick,
  selectedProvider,
  config,
  toolsCount = 0,
  serversCount = 0,
}) => {
  return (
    <div className="flex justify-center min-h-full p-8 pt-12">
      <div className="text-center max-w-2xl space-y-6 my-auto">
        <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <ProviderLogo
            className="text-slate-600 dark:text-slate-300"
            size={20}
            provider={selectedProvider}
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100">
            {config.title}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {config.subtitle || "Ask me anything - I'm here to help!"}
          </p>
          {config.showServersCount && (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {serversCount} connected servers • {toolsCount} tools available
            </p>
          )}
        </div>

        {selectedProvider === "ollama" && <OllamaSetupGuide />}

        <div className="grid grid-cols-1 gap-2 pt-2">
          {config.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              className="px-4 py-2 text-sm bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export type { ChatConfig };
