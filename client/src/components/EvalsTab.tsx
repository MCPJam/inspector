import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { FlaskConical, Play, Clock, CheckCircle, XCircle } from "lucide-react";
import { useQuery } from "convex/react";
import { EmptyState } from "./ui/empty-state";
import { MastraMCPServerDefinition } from "@mastra/mcp";

interface EvalsTabProps {
  serverConfig?: MastraMCPServerDefinition;
  serverName?: string;
}

export function EvalsTab({ serverConfig, serverName }: EvalsTabProps) {
  const evals = useQuery(
    "evals/helpers:getCurrentUserEvals" as any,
  ) as unknown as {
    _id: string;
    createdBy: string;
    lastUpdatedAt: number;
    status: "pending" | "resolved" | "cancelled";
    usageRecordId: string | null;
    runId: string;
    passed: boolean;
    expectedToolCalls: string[];
    actualToolCalls: string[];
    traceBlob: string | null;
  }[];

  const isLoading = evals === undefined;

  console.log(evals);

  const getStatusIcon = (status: string, passed: boolean) => {
    if (status === "pending") {
      return <Clock className="h-4 w-4 text-yellow-500" />;
    }
    if (status === "cancelled") {
      return <XCircle className="h-4 w-4 text-gray-500" />;
    }
    return passed ? (
      <CheckCircle className="h-4 w-4 text-green-500" />
    ) : (
      <XCircle className="h-4 w-4 text-red-500" />
    );
  };

  const getStatusColor = (status: string, passed: boolean) => {
    if (status === "pending")
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    if (status === "cancelled")
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
    return passed
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No Server Selected"
        description="Connect to an MCP server to run and monitor evaluations for testing your tools."
      />
    );
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
            <p className="mt-4 text-muted-foreground">Loading evaluations...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <FlaskConical className="h-6 w-6" />
          <h1 className="text-2xl font-bold">Evaluations</h1>
        </div>
        <Button>
          <Play className="h-4 w-4 mr-2" />
          Run New Eval
        </Button>
      </div>

      <div className="grid gap-4">
        {evals.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="No Evaluations Yet"
            description="Run your first evaluation to get started testing your MCP tools and monitor their performance."
            className="h-[calc(100vh-200px)]"
          />
        ) : (
          evals.map((evalRecord) => (
            <Card
              key={evalRecord._id}
              className="hover:shadow-md transition-shadow"
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    {getStatusIcon(evalRecord.status, evalRecord.passed)}
                    <span>Run {evalRecord.runId}</span>
                  </CardTitle>
                  <div className="flex items-center space-x-2">
                    <Badge
                      className={getStatusColor(
                        evalRecord.status,
                        evalRecord.passed,
                      )}
                    >
                      {evalRecord.status}
                    </Badge>
                    {evalRecord.status === "resolved" && (
                      <Badge
                        variant={evalRecord.passed ? "default" : "destructive"}
                      >
                        {evalRecord.passed ? "Passed" : "Failed"}
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 text-sm">
                  <div>
                    <span className="font-medium text-muted-foreground">
                      Last Updated:
                    </span>
                    <p>{formatTime(evalRecord.lastUpdatedAt)}</p>
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <div>
                    <h4 className="font-medium mb-2">Expected Tool Calls:</h4>
                    <div className="flex flex-wrap gap-1">
                      {evalRecord.expectedToolCalls.length > 0 ? (
                        evalRecord.expectedToolCalls.map((tool, index) => (
                          <Badge key={index} variant="outline">
                            {tool}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-sm">
                          None
                        </span>
                      )}
                    </div>
                  </div>

                  <div>
                    <h4 className="font-medium mb-2">Actual Tool Calls:</h4>
                    <div className="flex flex-wrap gap-1">
                      {evalRecord.actualToolCalls.length > 0 ? (
                        evalRecord.actualToolCalls.map((tool, index) => (
                          <Badge key={index} variant="outline">
                            {tool}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-sm">
                          None
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {evalRecord.status === "resolved" && (
                  <div className="pt-2">
                    <Button variant="outline" size="sm" className="w-full">
                      View Trace Details
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
