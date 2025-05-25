import React, { useState, useRef, useEffect } from "react";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Label } from "../components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ScrollArea } from "../components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Info, AlertCircle, Send, User, Bot } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: {
    name: string;
    args: Record<string, unknown>;
    result: string;
  }[];
}

interface ChatTabProps {
  tools: Tool[];
  callTool: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

// Add a type definition for Claude API messages
type ClaudeMessage = {
  role: string;
  content: string | Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string;
  }>;
};

const ChatTab: React.FC<ChatTabProps> = ({ tools, callTool }) => {
  const [claudeApiKey, setClaudeApiKey] = useState<string>(
    localStorage.getItem("claude_api_key") || ""
  );
  const [isClaudeKeyValid, setIsClaudeKeyValid] = useState<boolean>(
    !!localStorage.getItem("claude_api_key")
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("claude-3-5-sonnet-20241022");

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const models = [
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    { value: "claude-3-opus-20240229", label: "Claude 3 Opus" },
    { value: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet" },
    { value: "claude-3-haiku-20240307", label: "Claude 3 Haiku" },
  ];

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const saveApiKey = () => {
    if (claudeApiKey) {
      localStorage.setItem("claude_api_key", claudeApiKey);
      setIsClaudeKeyValid(true);
      setError(null);
    } else {
      setError("Please enter a valid API key");
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  const formatToolsForClaude = () => {
    // Helper function to recursively sanitize schema objects
    const sanitizeSchema = (schema: unknown): unknown => {
      if (!schema || typeof schema !== 'object') return schema;
      
      // Handle array
      if (Array.isArray(schema)) {
        return schema.map(item => sanitizeSchema(item));
      }
      
      // Now we know it's an object
      const schemaObj = schema as Record<string, unknown>;
      const sanitized: Record<string, unknown> = {};
      
      // Process all properties
      for (const [key, value] of Object.entries(schemaObj)) {
        if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
          // Handle properties object
          const propertiesObj = value as Record<string, unknown>;
          const sanitizedProps: Record<string, unknown> = {};
          const keyMapping: Record<string, string> = {}; // To track original→sanitized key names
          
          // First pass: sanitize property keys
          for (const [propKey, propValue] of Object.entries(propertiesObj)) {
            const sanitizedKey = propKey.replace(/[^a-zA-Z0-9_-]/g, '_');
            keyMapping[propKey] = sanitizedKey;
            sanitizedProps[sanitizedKey] = sanitizeSchema(propValue);
          }
          
          sanitized[key] = sanitizedProps;
          
          // Update required fields if they exist
          if ('required' in schemaObj && Array.isArray(schemaObj.required)) {
            sanitized.required = (schemaObj.required as string[]).map(
              (req: string) => keyMapping[req] || req
            );
          }
        } else {
          // Handle other properties
          sanitized[key] = sanitizeSchema(value);
        }
      }
      
      return sanitized;
    };
    
    // Claude may have limits on the number of tools, so let's limit to most important ones
    const MAX_TOOLS = 50;
    let limitedTools = tools;
    
    if (tools.length > MAX_TOOLS) {
      console.warn(`Tool count (${tools.length}) exceeds Claude's recommended limit. Limiting to ${MAX_TOOLS} tools.`);
      limitedTools = tools.slice(0, MAX_TOOLS);
    }
    
    const formattedTools = limitedTools.map((tool) => {
      // Create a deep copy and sanitize the schema
      const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema));
      const sanitizedSchema = sanitizeSchema(inputSchema);
      
      return {
        name: tool.name,
        description: tool.description,
        input_schema: sanitizedSchema,
      };
    });
    
    // Debug logging to see what's being sent to Claude
    console.log('Sanitized tools for Claude:', JSON.stringify(formattedTools, null, 2));
    
    return formattedTools;
  };

  // Add this utility function to format tool results for Claude
  const formatToolResult = (result: unknown): string => {
    if (!result) return "Tool execution completed but returned no data";
    
    // If result is a string, check if it looks like an error or empty result
    if (typeof result === 'string') {
      if (result.trim() === '') return "Tool execution completed but returned empty string";
      return `Tool execution successful. Result: ${result}`;
    }
    
    // If result has a content property, use that
    if (typeof result === 'object' && result !== null) {
      if ('content' in result && typeof result.content === 'string') {
        const content = result.content;
        if (content.trim() === '') return "Tool execution completed but returned empty content";
        return `Tool execution successful. Content: ${content}`;
      }
      
      // Check if it's an array with data
      if (Array.isArray(result)) {
        if (result.length === 0) return "Tool execution successful but returned empty array";
        return `Tool execution successful. Found ${result.length} items: ${JSON.stringify(result, null, 2)}`;
      }
      
      // Check if it's an object with data properties
      const resultObj = result as Record<string, unknown>;
      if ('data' in resultObj) {
        const data = resultObj.data;
        if (Array.isArray(data)) {
          if (data.length === 0) return "Tool execution successful but data array is empty";
          return `Tool execution successful. Found ${data.length} items in data: ${JSON.stringify(result, null, 2)}`;
        }
      }
      
      // Try to stringify the result
      try {
        const jsonResult = JSON.stringify(result, null, 2);
        // Check if the object has meaningful content
        if (jsonResult === '{}') return "Tool execution successful but returned empty object";
        return `Tool execution successful. Result data: ${jsonResult}`;
      } catch {
        // Stringify failed, use a simpler approach
        return `Tool execution successful but result could not be formatted: ${String(result)}`;
      }
    }
    
    // Fallback for other types
    return `Tool execution successful. Result: ${String(result)}`;
  };

  const handleSendMessage = async () => {
    if (!input.trim() || !isClaudeKeyValid) return;

    try {
      setIsLoading(true);
      setError(null);

      // Add user message to chat
      const userMessage: ChatMessage = { role: "user", content: input };
      setMessages((prev) => [...prev, userMessage]);
      setInput("");

      // Create a deep copy of messages to avoid mutation issues
      const currentMessages = JSON.parse(JSON.stringify(messages.concat(userMessage)));
      
      // Initialize empty array for Claude API messages
      const apiMessages: ClaudeMessage[] = [];

      // Convert conversation history to Claude format
      // This is a simpler approach that doesn't try to reconstruct historical tool calls
      currentMessages.forEach((msg: ChatMessage) => {
        if (!msg.toolCalls || msg.toolCalls.length === 0) {
          // Regular messages without tool calls
          apiMessages.push({
            role: msg.role,
            content: msg.content,
          });
        } else {
          // For messages with tool calls, add a text summary
          const toolSummary = msg.toolCalls
            .map(tc => `Used tool "${tc.name}" with result: ${tc.result.substring(0, 100)}${tc.result.length > 100 ? '...' : ''}`)
            .join('\n');
          
          apiMessages.push({
            role: msg.role,
            content: msg.content + (msg.content ? '\n\n' : '') + toolSummary,
          });
        }
      });

      // Create the assistant message object for our UI
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: "",
        toolCalls: [],
      };

      // Format tools for Claude
      const formattedTools = formatToolsForClaude();

      // Log the request for debugging
      console.log("Sending to Claude API:", {
        model: selectedModel,
        messages: apiMessages,
        tools: formattedTools
      });

      // Make initial request to Claude API
      const response = await fetch("/api/proxy/anthropic", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: "https://api.anthropic.com/v1/messages",
          apiKey: claudeApiKey,
          data: {
            model: selectedModel,
            max_tokens: 1000,
            messages: apiMessages,
            tools: formattedTools,
          },
        }),
      });

      // Handle errors
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Error (${response.status}): ${response.statusText}`;
        
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error?.message) {
            errorMessage = errorData.error.message;
          }
        } catch {
          if (errorText) {
            errorMessage = errorText;
          }
        }
        
        throw new Error(errorMessage);
      }

      // Process the response
      let data = await response.json();
      
      // Process content parts from the response
      for (let i = 0; i < data.content.length; i++) {
        const content = data.content[i];
        
        if (content.type === "text") {
          // Add text content
          assistantMessage.content += content.text;
        } 
        else if (content.type === "tool_use") {
          try {
            console.log(`Calling tool: ${content.name} with args:`, content.input);
            
            // Call the tool
            const result = await callTool(content.name, content.input);
            console.log("Tool result:", result);
            
            // Format the result with better success indication
            const formattedResult = formatToolResult(result);
            
            // Add to our UI message
            assistantMessage.toolCalls = [
              ...(assistantMessage.toolCalls || []),
              {
                name: content.name,
                args: content.input,
                result: formattedResult,
              },
            ];
            
            // Create a more informative tool result for Claude
            const toolResultForClaude = `TOOL_CALL_SUCCESS: ${content.name}
${formattedResult}

This tool call was executed successfully. The above contains the actual returned data.`;
            
            // Create a new sequence with:
            // 1. All previous messages
            // 2. Assistant message with just this tool_use
            // 3. User message with just the tool_result
            const toolMessages: ClaudeMessage[] = [
              ...apiMessages,
              {
                role: "assistant",
                content: [{ 
                  type: "tool_use", 
                  id: content.id, 
                  name: content.name, 
                  input: content.input 
                }]
              },
              {
                role: "user",
                content: [{ 
                  type: "tool_result", 
                  tool_use_id: content.id, 
                  content: toolResultForClaude 
                }]
              }
            ];
            
            console.log("Sending tool result to Claude:", JSON.stringify(toolMessages, null, 2));
            
            // Make a follow-up request with the tool result
            const followUpResponse = await fetch("/api/proxy/anthropic", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                url: "https://api.anthropic.com/v1/messages",
                apiKey: claudeApiKey,
                data: {
                  model: selectedModel,
                  max_tokens: 1000,
                  messages: toolMessages,
                  tools: formattedTools,
                },
              }),
            });
            
            if (!followUpResponse.ok) {
              throw new Error(`Follow-up request failed: ${followUpResponse.status} ${followUpResponse.statusText}`);
            }
            
            // Process the follow-up response
            const followUpData = await followUpResponse.json();
            
            // Replace the full data object for the next iteration
            data = followUpData;
            
            // Reset the counter to -1 (will become 0 after increment)
            i = -1;
            
            // Clear previous content since we have a new response
            assistantMessage.content = "";
          } 
          catch (toolError: unknown) {
            console.error("Tool error:", toolError);
            const errorMessage = toolError instanceof Error ? toolError.message : "Unknown error";
            
            // Add error info to UI message
            assistantMessage.toolCalls = [
              ...(assistantMessage.toolCalls || []),
              {
                name: content.name,
                args: content.input,
                result: `TOOL_CALL_FAILED: ${errorMessage}`,
              },
            ];
            
            assistantMessage.content += `\n\nError executing tool ${content.name}: ${errorMessage}`;
          }
        }
      }

      // Add the final assistant message to the chat
      setMessages((prev) => [...prev, assistantMessage]);
    } 
    catch (err: unknown) {
      console.error("Error details:", err);
      const errorMessage = err instanceof Error 
        ? `${err.message}${err.stack ? `\n\nStack: ${err.stack}` : ''}`
        : 'An error occurred while processing your request';
      setError(errorMessage);
    } 
    finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Tabs defaultValue="chat" className="w-full h-full">
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        
        <TabsContent value="chat" className="flex-1 flex flex-col h-full">
          {!isClaudeKeyValid ? (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Authentication Required</AlertTitle>
              <AlertDescription>
                Please enter your Claude API key in the Settings tab to start chatting.
              </AlertDescription>
            </Alert>
          ) : null}
          
          <Card className="flex-1 flex flex-col">
            <CardHeader>
              <CardTitle>Chat with Claude</CardTitle>
              <CardDescription>
                This chat uses MCP tools and Claude to provide answers
              </CardDescription>
              <div className="flex justify-end">
                <Button variant="outline" onClick={clearChat} disabled={messages.length === 0}>
                  Clear Chat
                </Button>
              </div>
            </CardHeader>
            
            <CardContent className="flex-1 overflow-hidden">
              <ScrollArea className="h-[calc(100vh-300px)] pr-4">
                {messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    <div className="text-center">
                      <Info className="mx-auto h-12 w-12 mb-2" />
                      <p>Start a conversation with Claude</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages.map((message, index) => (
                      <div
                        key={index}
                        className={`flex ${
                          message.role === "user" ? "justify-end" : "justify-start"
                        }`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg p-3 ${
                            message.role === "user"
                              ? "bg-blue-500 text-white"
                              : "bg-gray-100 dark:bg-gray-800"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            {message.role === "user" ? (
                              <User className="h-4 w-4" />
                            ) : (
                              <Bot className="h-4 w-4" />
                            )}
                            <span className="font-semibold">
                              {message.role === "user" ? "You" : "Claude"}
                            </span>
                          </div>
                          
                          <div className="whitespace-pre-wrap">{message.content}</div>
                          
                          {message.toolCalls && message.toolCalls.length > 0 && (
                            <div className="mt-2 text-sm border-t pt-2">
                              <p className="font-semibold">Tools used:</p>
                              {message.toolCalls && message.toolCalls.map((tool, toolIndex) => (
                                <div key={toolIndex} className="mt-1 p-2 bg-gray-200 dark:bg-gray-700 rounded">
                                  <p className="font-medium">{tool.name}</p>
                                  <pre className="text-xs mt-1 overflow-x-auto">
                                    {JSON.stringify(tool.args, null, 2)}
                                  </pre>
                                  <p className="mt-1 text-xs font-medium">Result:</p>
                                  <pre className="text-xs mt-1 overflow-x-auto">
                                    {tool.result}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </ScrollArea>
            </CardContent>
            
            <CardFooter>
              {error && (
                <Alert variant="destructive" className="mb-2 w-full">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              
              <div className="flex w-full space-x-2">
                <Textarea
                  placeholder="Type your message..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  disabled={isLoading || !isClaudeKeyValid}
                  className="flex-1"
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={isLoading || !input.trim() || !isClaudeKeyValid}
                >
                  {isLoading ? "Sending..." : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </CardFooter>
          </Card>
        </TabsContent>
        
        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle>Chat Settings</CardTitle>
              <CardDescription>
                Configure your Claude API key and model preferences
              </CardDescription>
            </CardHeader>
            
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="apiKey">Claude API Key</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={claudeApiKey}
                  onChange={(e) => setClaudeApiKey(e.target.value)}
                  placeholder="sk-ant-api..."
                />
                <p className="text-sm text-gray-500">
                  Your API key is stored locally in your browser and is never sent to our servers.
                </p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Select
                  value={selectedModel}
                  onValueChange={setSelectedModel}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <Button onClick={saveApiKey}>Save Settings</Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ChatTab; 