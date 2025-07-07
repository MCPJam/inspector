import React from "react";
import { SupportedProvider } from "@/lib/providers";
import { ProviderConfig, ProviderData } from "@/components/settings/types";
import { Eye, EyeOff, ChevronDown } from "lucide-react";

interface Props {
  provider: SupportedProvider;
  config: ProviderConfig & { logo: string };
  data: ProviderData;
  isCollapsed?: boolean;
  disabled?: boolean;
  onChange: (p: SupportedProvider, v: string) => void;
  onClear: (p: SupportedProvider) => void;
  onToggleShow: (p: SupportedProvider) => void;
  onToggleCollapse: (p: SupportedProvider) => void;
}

const ProviderCard: React.FC<Props> = ({
  provider,
  config,
  data,
  isCollapsed = false,
  disabled = false,
  onChange,
  onClear,
  onToggleShow,
  onToggleCollapse,
}) => {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-lg transition p-6 flex flex-col">
      {/* Header */}
      <div className="flex items-center mb-4">
        <img
          src={config.logo}
          alt={`${config.displayName} logo`}
          className="w-6 h-6 mr-3"
        />
        <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {config.displayName}
        </h3>
        <button
          onClick={() => onToggleCollapse(provider)}
          className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          <ChevronDown
            className={`w-5 h-5 transform transition-transform ${
              isCollapsed ? "rotate-180" : "rotate-0"
            }`}
          />
        </button>
      </div>

      {/* Description */}
      <p className="text-gray-600 dark:text-gray-400 mb-4 text-sm">
        {config.description}
      </p>

      {/* Content */}
      {!isCollapsed ? (
        <div className="space-y-4">
          <div className="relative">
            <input
              type="text"
              value={data.key}
              placeholder={config.placeholder}
              disabled={disabled}
              onChange={(e) => onChange(provider, e.target.value)}
              className="w-full pr-10 p-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <button
              onClick={() => onToggleShow(provider)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {data.showKey ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <div className="flex space-x-3">
            <button
              onClick={() => onChange(provider, data.key)}
              disabled={disabled || !data.key}
              className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white py-2 rounded-lg transition disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => onClear(provider)}
              disabled={disabled || !data.key}
              className="flex-1 border border-red-500 hover:border-red-600 text-red-500 hover:text-red-600 py-2 rounded-lg transition disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm text-green-600 dark:text-green-400">
            ••••••••
          </span>
          <button
            onClick={() => onClear(provider)}
            disabled={disabled}
            className="text-red-500 hover:text-red-600 text-sm"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
};

export default ProviderCard;
