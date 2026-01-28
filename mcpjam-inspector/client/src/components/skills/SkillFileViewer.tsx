import { useMemo } from "react";
import { RefreshCw, FileText, Copy, Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MemoizedMarkdown } from "@/components/chat-v2/thread/memomized-markdown";
import type { SkillFileContent } from "@shared/skill-types";
import { useState } from "react";

interface SkillFileViewerProps {
  file: SkillFileContent | null;
  loading?: boolean;
  error?: string;
  onLinkClick?: (path: string) => void;
}

/**
 * Get language identifier from MIME type for code blocks
 */
function getLanguageFromMime(mimeType: string, fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  const extToLang: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    lua: "lua",
    r: "r",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    html: "html",
    htm: "html",
    css: "css",
    toml: "toml",
    ini: "ini",
  };

  return extToLang[ext] || "text";
}

/**
 * Wrap code content in a markdown code block for syntax highlighting
 */
function wrapAsCodeBlock(content: string, language: string): string {
  return "```" + language + "\n" + content + "\n```";
}

export function SkillFileViewer({
  file,
  loading,
  error,
  onLinkClick,
}: SkillFileViewerProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!file?.content) return;

    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleDownload = () => {
    if (!file) return;

    const content = file.isText ? file.content : file.base64;
    if (!content) return;

    const blob = file.isText
      ? new Blob([content], { type: file.mimeType })
      : new Blob([Uint8Array.from(atob(content), c => c.charCodeAt(0))], { type: file.mimeType });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Process markdown content to intercept relative links
  const processedContent = useMemo(() => {
    if (!file?.content || !file.mimeType.includes("markdown")) return null;

    // For now, return content as-is. Link interception would need custom markdown renderer
    return file.content;
  }, [file]);

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
          <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
        </div>
        <p className="text-xs text-muted-foreground font-semibold">
          Loading file...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium max-w-md text-center">
          {error}
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <FileText className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-xs text-muted-foreground">
          Select a file to view its content
        </p>
      </div>
    );
  }

  // Image files
  if (file.mimeType.startsWith("image/") && file.base64) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {file.path}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            className="h-6 px-2"
          >
            <Download className="h-3 w-3 mr-1" />
            Download
          </Button>
        </div>

        {/* Image content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-6 flex items-center justify-center">
            <img
              src={`data:${file.mimeType};base64,${file.base64}`}
              alt={file.name}
              className="max-w-full max-h-[70vh] object-contain rounded-md border border-border"
            />
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Markdown files
  if (file.mimeType.includes("markdown") && file.content) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {file.path}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-6 px-2"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 mr-1" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </>
            )}
          </Button>
        </div>

        {/* Markdown content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-6 prose prose-sm dark:prose-invert max-w-none">
            <MemoizedMarkdown content={processedContent || file.content} />
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Code/text files
  if (file.isText && file.content) {
    const language = getLanguageFromMime(file.mimeType, file.name);
    const codeBlock = wrapAsCodeBlock(file.content, language);

    return (
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {file.path}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-6 px-2"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 mr-1" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </>
            )}
          </Button>
        </div>

        {/* Code content with syntax highlighting via Streamdown */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4">
            <MemoizedMarkdown content={codeBlock} />
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Binary files (non-image)
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <span className="text-xs font-mono text-muted-foreground truncate">
          {file.path}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          className="h-6 px-2"
        >
          <Download className="h-3 w-3 mr-1" />
          Download
        </Button>
      </div>

      {/* Binary file message */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center p-6">
        <FileText className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <p className="text-sm font-medium text-foreground mb-1">Binary File</p>
        <p className="text-xs text-muted-foreground mb-4">
          {file.mimeType} ({formatFileSize(file.size)})
        </p>
        <Button variant="outline" size="sm" onClick={handleDownload}>
          <Download className="h-3 w-3 mr-2" />
          Download File
        </Button>
      </div>
    </div>
  );
}

/**
 * Format file size in human readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
