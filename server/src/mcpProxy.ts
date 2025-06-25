import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { logToFile } from "./logger.js";

function onClientError(error: Error, logFileName?: string) {
  console.error("Error from inspector client:", error);
  logToFile(
    "error",
    "client",
    error.message,
    { stack: error.stack },
    logFileName
  );
}

function onServerError(error: Error, logFileName?: string) {
  if (
    (error?.message &&
      error.message.includes("Error POSTing to endpoint (HTTP 404)")) ||
    (error?.cause && JSON.stringify(error.cause).includes("ECONNREFUSED"))
  ) {
    console.error("Connection refused. Is the MCP server running?");
    logToFile(
      "error",
      "server",
      "Connection refused. Is the MCP server running?",
      { message: error.message, stack: error.stack },
      logFileName
    );
  } else {
    console.error("Error from MCP server:", error);
    logToFile(
      "error",
      "server",
      error.message,
      { stack: error.stack },
      logFileName
    );
  }
}

export default function mcpProxy({
  transportToClient,
  transportToServer,
  logFileName,
}: {
  transportToClient: Transport;
  transportToServer: Transport;
  logFileName?: string;
}) {
  let transportToClientClosed = false;
  let transportToServerClosed = false;

  transportToClient.onmessage = (message) => {
    transportToServer.send(message).catch((error) => {
      // Send error response back to client if it was a request (has id) and connection is still open
      if (isJSONRPCRequest(message) && !transportToClientClosed) {
        const errorResponse = {
          jsonrpc: "2.0" as const,
          id: message.id,
          error: {
            code: -32001,
            message: error.message,
            data: error,
          },
        };
        transportToClient.send(errorResponse).catch((err) => onClientError(err, logFileName));
      }
    });
  };

  transportToServer.onmessage = (message) => {
    transportToClient.send(message).catch((err) => onClientError(err, logFileName));
  };

  transportToClient.onclose = () => {
    if (transportToServerClosed) {
      return;
    }

    transportToClientClosed = true;
    transportToServer.close().catch((err) => onServerError(err, logFileName));
  };

  transportToServer.onclose = () => {
    if (transportToClientClosed) {
      return;
    }
    transportToServerClosed = true;
    transportToClient.close().catch((err) => onClientError(err, logFileName));
  };

  transportToClient.onerror = (err) => onClientError(err, logFileName);
  transportToServer.onerror = (err) => onServerError(err, logFileName);
}
