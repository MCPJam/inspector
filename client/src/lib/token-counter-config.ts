// Performance settings for token counting
export const TOKEN_COUNTING_CONFIG = {
  // Debounce delay for input token counting (ms)
  DEBOUNCE_DELAY: 500,
  
  // Minimum input length before calculating tokens
  MIN_INPUT_LENGTH: 10,
  
  // Cache size for token counts
  CACHE_SIZE: 1000,
  
  // Maximum text length for precise counting (longer texts use estimation)
  MAX_PRECISE_LENGTH: 10000,
  
  // Enable/disable token counting globally
  ENABLED: true,
  
  // Enable detailed token counting (vs simple estimation)
  PRECISE_MODE: true,
} as const;

// Helper to check if token counting should be performed
export function shouldCountTokens(text: string, config = TOKEN_COUNTING_CONFIG): boolean {
  if (!config.ENABLED) return false;
  if (text.length < config.MIN_INPUT_LENGTH) return false;
  return true;
}

// Helper to check if precise counting should be used
export function shouldUsePreciseCounting(text: string, config = TOKEN_COUNTING_CONFIG): boolean {
  if (!config.PRECISE_MODE) return false;
  if (text.length > config.MAX_PRECISE_LENGTH) return false;
  return true;
}