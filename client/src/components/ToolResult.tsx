import { useState, useMemo } from "react";
import {
  CallToolResultSchema,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import JsonView from "./JsonView";

interface ToolResultProps {
  toolResult: CompatibilityCallToolResult | null;
}

const COLLAPSE_THRESHOLD = 500; // number of characters

const ToolResult = ({ toolResult }: ToolResultProps) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Determine if the result should be collapsible based on length
  const shouldBeCollapsible = useMemo(() => {
    if (!toolResult) return false;
    const contentLength = JSON.stringify(toolResult).length;
    return contentLength > COLLAPSE_THRESHOLD;
  }, [toolResult]);

  if (!toolResult) return null;

  // Toggle handler
  const toggleCollapse = () => setIsCollapsed((prev) => !prev);

  // If too long and currently collapsed, show a toggle prompt only
  if (shouldBeCollapsible && isCollapsed) {
    return (
      <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Tool result is lengthy & has been collapsed.
        </p>
        <button
          onClick={toggleCollapse}
          className="mt-2 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Show More
        </button>
      </div>
    );
  }

  // Full rendering when not collapsed
  if ("content" in toolResult) {
    const parsedResult = CallToolResultSchema.safeParse(toolResult);
    if (!parsedResult.success) {
      return (
        <>
          <h4 className="font-semibold mb-2">Invalid Tool Result:</h4>
          <JsonView data={toolResult} />
          <h4 className="font-semibold mb-2">Errors:</h4>
          {parsedResult.error.errors.map((error, idx) => (
            <JsonView data={error} key={idx} />
          ))}
        </>
      );
    }
    const structuredResult = parsedResult.data;
    const isError = structuredResult.isError ?? false;

    return (
      <div>
        <div className="flex items-center justify-between">
          <h4 className="font-semibold mb-2">
            Tool Result:{" "}
            {isError ? (
              <span className="text-red-600 font-semibold">Error</span>
            ) : (
              <span className="text-green-600 font-semibold">Success</span>
            )}
          </h4>
          {shouldBeCollapsible && (
            <button
              onClick={toggleCollapse}
              className="text-sm text-blue-600 hover:underline ml-4"
            >
              {isCollapsed ? "Show More" : "Show Less"}
            </button>
          )}
        </div>

        {structuredResult.content.map((item, index) => (
          <div key={index} className="mb-2">
            {item.type === "text" && (
              <JsonView data={item.text} isError={isError} />
            )}
            {item.type === "image" && (
              <img
                src={`data:${item.mimeType};base64,${item.data}`}
                alt="Tool result image"
                className="max-w-full h-auto"
              />
            )}
            {item.type === "resource" &&
              (item.resource?.mimeType?.startsWith("audio/") ? (
                <audio
                  controls
                  src={`data:${item.resource.mimeType};base64,${item.resource.blob}`}
                  className="w-full"
                >
                  <p>Your browser does not support audio playback</p>
                </audio>
              ) : (
                <JsonView data={item.resource} />
              ))}
          </div>
        ))}
      </div>
    );
  } else if ("toolResult" in toolResult) {
    return (
      <>
        <h4 className="font-semibold mb-2">Tool Result (Legacy):</h4>
        <JsonView data={toolResult.toolResult} />
      </>
    );
  }

  return null;
};

export default ToolResult;
