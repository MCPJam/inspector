import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/components/ui/json-editor";
import type { ServerWithName } from "@/state/app-types";

interface LearningSandboxServerInfoPanelProps {
  serverName: string;
  serverEntry?: ServerWithName;
  initInfo?: ServerWithName["initializationInfo"];
  onReconnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
}

function formatStatusVariant(
  status: string,
): "default" | "outline" | "secondary" {
  if (status === "connected") {
    return "default";
  }
  if (status === "connecting") {
    return "secondary";
  }
  return "outline";
}

export function LearningSandboxServerInfoPanel({
  serverName,
  serverEntry,
  initInfo,
  onReconnect,
  onDisconnect,
}: LearningSandboxServerInfoPanelProps) {
  const status = serverEntry?.connectionStatus ?? "disconnected";
  const protocolVersion =
    typeof initInfo?.protocolVersion === "string"
      ? initInfo.protocolVersion
      : undefined;
  const capabilities =
    initInfo?.serverCapabilities &&
    typeof initInfo.serverCapabilities === "object" &&
    !Array.isArray(initInfo.serverCapabilities)
      ? Object.keys(initInfo.serverCapabilities as Record<string, unknown>)
      : [];

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-sm">Learning server context</CardTitle>
            <CardDescription className="text-xs">
              Runtime-only connection metadata for the hidden sandbox server.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={formatStatusVariant(status)}>{status}</Badge>
            {onReconnect ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onReconnect()}
              >
                Reconnect
              </Button>
            ) : null}
            {onDisconnect ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onDisconnect()}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{serverName}</Badge>
          {protocolVersion ? (
            <Badge variant="outline">protocol {protocolVersion}</Badge>
          ) : null}
          {capabilities.length > 0
            ? capabilities.map((capability) => (
                <Badge key={capability} variant="outline">
                  {capability}
                </Badge>
              ))
            : null}
        </div>
        <div className="h-44 overflow-hidden rounded-md border border-border/60">
          <JsonEditor
            value={
              initInfo ?? { status, error: serverEntry?.lastError ?? null }
            }
            readOnly
            showToolbar={false}
            height="100%"
          />
        </div>
      </CardContent>
    </Card>
  );
}
