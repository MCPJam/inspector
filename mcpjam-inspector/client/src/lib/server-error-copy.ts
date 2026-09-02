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
 * So attribution moves to the copy layer, split across the two fields a toast
 * renders: the server name as the title, the failure as the description. It
 * applies only when the message does not already carry the name — otherwise
 * the title repeats what the sentence below it already says, and the caller
 * shows the message as it stands.
 */
export function splitServerAttribution(
  serverName: string,
  message: string,
): { title: string; description?: string } {
  const trimmed = message.trim();
  if (!serverName) return { title: trimmed };
  // Substring, not an exact quoted form: the SDK quotes it
  // (`MCP server "champions"`) while other messages may not, and either way
  // the name is already on screen.
  if (trimmed.includes(serverName)) return { title: trimmed };
  return { title: serverName, description: trimmed };
}
