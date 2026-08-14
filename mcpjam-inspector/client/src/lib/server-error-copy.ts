/**
 * Attribute a connect/reconnect failure to the server it came from, without
 * saying the name twice.
 *
 * The route used to prefix its own payload with "Connection failed for server
 * X:". That was removed: it pushed the sentence explaining the failure into
 * the second half of the line, and against an error that names the server
 * itself it repeated the name. But a generic failure — "Connection refused" —
 * then says nothing about WHICH server, and several can fail at once.
 *
 * So attribution moves to the copy layer, and applies only when the message
 * does not already carry the name. Callers that build their own sentence
 * around the server ("Failed to connect to X: …") do not need this.
 */
export function attributeToServer(
  serverName: string,
  message: string,
): string {
  const trimmed = message.trim();
  if (!serverName) return trimmed;
  // Substring, not an exact quoted form: the SDK quotes it
  // (`MCP server "champions"`) while other messages may not, and either way
  // the name is already on screen.
  if (trimmed.includes(serverName)) return trimmed;
  return `${serverName}: ${trimmed}`;
}
