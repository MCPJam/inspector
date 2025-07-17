import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="max-w-4xl w-full">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-2">MCPJam Inspector</h1>
          <h2 className="text-2xl text-gray-600 dark:text-gray-300">Powered by Mastra</h2>
          <p className="mt-4 text-gray-600 dark:text-gray-400">
            Connect to any MCP server and test your implementation
          </p>
        </div>
        
        <div className="card mb-8">
          <h3 className="text-xl font-semibold mb-4">Quick Start</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Link 
              href="/connect" 
              className="btn-primary text-center"
            >
              Connect to Server
            </Link>
            <Link 
              href="/server-management" 
              className="btn-secondary text-center"
            >
              Manage Servers
            </Link>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div className="card">
            <h3 className="text-lg font-semibold mb-2">Resources</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">View and interact with MCP server resources</p>
            <Link href="/resources" className="text-blue-600 dark:text-blue-400 hover:underline">
              Explore resources ’
            </Link>
          </div>
          
          <div className="card">
            <h3 className="text-lg font-semibold mb-2">Tools</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">Execute MCP server tools with parameter input</p>
            <Link href="/tools" className="text-blue-600 dark:text-blue-400 hover:underline">
              Test tools ’
            </Link>
          </div>
          
          <div className="card">
            <h3 className="text-lg font-semibold mb-2">Prompts</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">Work with MCP server prompts</p>
            <Link href="/prompts" className="text-blue-600 dark:text-blue-400 hover:underline">
              View prompts ’
            </Link>
          </div>
          
          <div className="card">
            <h3 className="text-lg font-semibold mb-2">Chat</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">Test LLM tool interactions</p>
            <Link href="/chat" className="text-blue-600 dark:text-blue-400 hover:underline">
              Open chat ’
            </Link>
          </div>
          
          <div className="card">
            <h3 className="text-lg font-semibold mb-2">Console</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">View debug logs</p>
            <Link href="/console" className="text-blue-600 dark:text-blue-400 hover:underline">
              Open console ’
            </Link>
          </div>
          
          <div className="card">
            <h3 className="text-lg font-semibold mb-2">Documentation</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">Learn more about MCP</p>
            <Link href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
              Read docs ’
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}