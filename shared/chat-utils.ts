/**
 * Get default temperature value based on the model provider
 */
export function getDefaultTemperatureByProvider(provider: string): number {
  switch (provider) {
    case "openai":
      return 1.0;
    case "anthropic":
      return 0;
    case "google":
      return 0.9; // Google's recommended default
    case "mistral":
      return 0.7; // Mistral's recommended default
    default:
      return 0;
  }
}
