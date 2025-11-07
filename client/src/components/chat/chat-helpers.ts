import { ModelDefinition } from "@/shared/types.js";
import {
  getProviderLogo,
  getProviderColor as getSharedProviderColor,
  type ThemeMode,
} from "@/lib/provider-logos";

/**
 * @deprecated Use getProviderLogo from @/lib/provider-logos instead
 */
export const getProviderLogoFromProvider = (
  provider: string,
  themeMode?: ThemeMode,
): string | null => {
  return getProviderLogo(provider, themeMode);
};

/**
 * @deprecated Use getProviderLogo from @/lib/provider-logos instead
 */
export const getProviderLogoFromModel = (
  model: ModelDefinition,
  themeMode?: ThemeMode,
): string | null => {
  return getProviderLogo(model.provider, themeMode);
};

/**
 * @deprecated Use getProviderColor from @/lib/provider-logos instead
 */
export const getProviderColor = (provider: string): string => {
  return getSharedProviderColor(provider);
};
