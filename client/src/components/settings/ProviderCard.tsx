import React from "react";
import { SupportedProvider } from "@/lib/providers";
import { ProviderConfig, ProviderData } from "@/components/settings/types";
import { Eye, EyeOff } from "lucide-react";

interface Props {
  provider: SupportedProvider;
  config: ProviderConfig & { logo: string };
  data: ProviderData;
  disabled?: boolean;
  onChange: (p: SupportedProvider, v: string) => void;
  onClear: (p: SupportedProvider) => void;
  onToggleShow: (p: SupportedProvider) => void;
}

const ProviderCard: React.FC<Props> = ({
  provider,
  config,
  data,
  disabled = false,
  onChange,
  onClear,
  onToggleShow,
}) => {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-lg transition p-6 flex flex-col">
      {/* Header */}
      <div className="flex items-center mb-4 -ml-1">
        <div className="w-8 h-8 flex items-center justify-center bg-white rounded-md">
          <img
            src={config.logo}
            alt={`${config.displayName} logo`}
            className="w-5 h-5"
          />
        </div>
        <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {config.displayName}
        </h3>
      </div>

      {/* Description */}
      <p className="text-gray-600 dark:text-gray-400 mb-4 text-sm">
        {config.description}
      </p>

      {/* Content */}
      <div className="space-y-4">
        <div className="relative">
          <input
            type={data.showKey ? "text" : "password"}
            value={data.key}
            placeholder={config.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(provider, e.target.value)}
            className="w-full pr-10 p-2 text-sm border rounded-lg bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={() => onToggleShow(provider)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            disabled={disabled || !data.key}
          >
            {data.showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={() => onChange(provider, data.key)}
            disabled={disabled || !data.key}
            className="flex-1 bg-gray-600 hover:bg-gray-700 text-white text-sm py-1 rounded transition disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => onClear(provider)}
            disabled={disabled || !data.key}
            className="flex-1 border border-gray-400 hover:border-gray-500 text-gray-400 hover:text-gray-600 text-sm py-1 rounded transition disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProviderCard;
