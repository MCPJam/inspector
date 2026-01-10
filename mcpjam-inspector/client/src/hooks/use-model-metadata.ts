import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import type {
  OpenRouterModel,
  ModelMetadataResponse,
} from "@/types/model-metadata";

/**
 * Hook to fetch MCPJam provided model metadata from the backend
 * This calls the local inspector server, which proxies to the Convex backend
 */
export function useModelMetadata() {
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAuthenticated } = useConvexAuth();
  const { getAccessToken } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) {
      setModels([]);
      setError("Sign in to view model metadata");
      return;
    }

    const fetchModelMetadata = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Get WorkOS access token to pass to the inspector server
        const accessToken = await getAccessToken();

        // Call the local inspector server which proxies to Convex
        // Use the same pattern as chat.ts - pass token in Authorization header
        const response = await fetch(`/api/mcp/models`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const data: ModelMetadataResponse = await response.json();

        if (!data.ok || !data.data) {
          throw new Error(data.error || "Failed to fetch model metadata");
        }

        setModels(data.data);
      } catch (err) {
        console.error("Failed to fetch model metadata:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setModels([]);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchModelMetadata();
  }, [isAuthenticated, getAccessToken]);

  return {
    models,
    isLoading,
    error,
  };
}
