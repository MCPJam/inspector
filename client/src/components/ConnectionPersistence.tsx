import React, { useRef } from "react";
import { useFilePersistence } from "@/hooks/useFilePersistence";
import { MCPJamServerConfig } from "@/lib/types/serverTypes";

interface ConnectionPersistenceProps {
  connections: Record<string, MCPJamServerConfig>;
  onConnectionsImported?: (connections: Record<string, MCPJamServerConfig>) => void;
}

export const ConnectionPersistence: React.FC<ConnectionPersistenceProps> = ({
  connections,
  onConnectionsImported,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    state,
    saveConnectionsToFile,
    exportConnections,
    importConnectionsFromFile,
    clearError,
  } = useFilePersistence();

  const handleSave = async () => {
    const success = await saveConnectionsToFile(connections);
    if (success) {
      console.log("Connections saved successfully");
    }
  };

  const handleExport = async () => {
    const success = await exportConnections();
    if (success) {
      console.log("Connections exported successfully");
    }
  };

  const handleImport = async (merge: boolean = false) => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
      fileInputRef.current.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const importedConnections = await importConnectionsFromFile(file, merge);
          if (importedConnections && onConnectionsImported) {
            onConnectionsImported(importedConnections);
          }
        }
      };
    }
  };

  const hasConnections = Object.keys(connections).length > 0;

  return (
    <div className="space-y-4">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
      />

      {/* Error display */}
      {state.error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
          <span className="block sm:inline">{state.error}</span>
          <button
            className="absolute top-0 bottom-0 right-0 px-4 py-3"
            onClick={clearError}
          >
            <span className="sr-only">Dismiss</span>
            ✕
          </button>
        </div>
      )}

      {/* Success info */}
      {state.lastSaved && !state.error && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
          <span className="block sm:inline">
            Connections saved successfully at {state.lastSaved.toLocaleTimeString()}
            {state.filePath && (
              <span className="block text-sm opacity-75">
                File: {state.filePath}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleSave}
          disabled={state.isLoading || !hasConnections}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {state.isLoading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          ) : (
            "💾"
          )}
          Save to File
        </button>

        <button
          onClick={handleExport}
          disabled={state.isLoading || !hasConnections}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {state.isLoading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          ) : (
            "📥"
          )}
          Export
        </button>

        <button
          onClick={() => handleImport(false)}
          disabled={state.isLoading}
          className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {state.isLoading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          ) : (
            "📤"
          )}
          Import (Replace)
        </button>

        <button
          onClick={() => handleImport(true)}
          disabled={state.isLoading}
          className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {state.isLoading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          ) : (
            "📤"
          )}
          Import (Merge)
        </button>
      </div>

      {/* Info text */}
      <div className="text-sm text-gray-600 dark:text-gray-400">
        <p>
          <strong>Save to File:</strong> Saves connections to <code>mcp.json</code> for persistence across sessions.
        </p>
        <p>
          <strong>Export:</strong> Downloads connections as a JSON file for backup or sharing.
        </p>
        <p>
          <strong>Import:</strong> Load connections from a JSON file. "Replace" overwrites existing connections, "Merge" combines them.
        </p>
        {state.filePath && (
          <p className="mt-2 font-mono text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded">
            Current file: {state.filePath}
          </p>
        )}
      </div>
    </div>
  );
};