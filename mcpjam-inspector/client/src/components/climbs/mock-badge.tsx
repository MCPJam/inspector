import { Badge } from "@mcpjam/design-system/badge";

/** The one mark that says a server is a mock. */
export function MockBadge() {
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-normal">
      Mock
    </Badge>
  );
}
