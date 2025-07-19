import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ActiveServerSelectorProps {
  connectedServers: string[];
  selectedServer: string;
  onServerChange: (server: string) => void;
}

export function ActiveServerSelector({
  connectedServers,
  selectedServer,
  onServerChange,
}: ActiveServerSelectorProps) {
  if (connectedServers.length === 0) {
    return null;
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Active Server</CardTitle>
      </CardHeader>
      <CardContent>
        <select
          value={selectedServer}
          onChange={(e) => onServerChange(e.target.value)}
          className="w-full p-2 border rounded"
        >
          <option value="none">Select a server...</option>
          {connectedServers.map((server) => (
            <option key={server} value={server}>
              {server}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  );
}
