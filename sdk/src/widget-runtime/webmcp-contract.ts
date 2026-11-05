/** Reserved app-view messages, shared by the host and injected sandbox code. */
export const WEBMCP_APP_CONTRACT = Object.freeze({
  list: "ui/sandbox-list-tools",
  call: "ui/sandbox-call-tool",
  changed: "ui/notifications/sandbox-tools-changed",
  maxResultBytes: 256 * 1024,
  maxSchemaBytes: 8 * 1024,
  maxTools: 64,
  maxDescriptionChars: 512,
});
