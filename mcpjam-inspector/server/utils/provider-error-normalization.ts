export function isProviderOverloadError(options: {
  message: string;
  statusCode?: number;
  responseBody?: string;
}): boolean {
  const lowerMessage = options.message.toLowerCase();
  const lowerBody = options.responseBody?.toLowerCase() ?? "";
  return (
    options.statusCode === 529 ||
    lowerMessage.includes("overloaded") ||
    lowerBody.includes("overloaded") ||
    lowerBody.includes("overloaded_error")
  );
}

export function formatProviderOverloadError(options: {
  statusCode?: number;
  responseBody?: string;
}): string {
  return JSON.stringify({
    code: "provider_overloaded",
    message:
      "That model is temporarily overloaded. Try again in a moment or switch models.",
    statusCode: options.statusCode,
    isRetryable: true,
    ...(options.responseBody ? { details: options.responseBody } : {}),
  });
}
