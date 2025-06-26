import React, { useState } from "react";
// import { Button } from "@/components/ui/button";
import ToolsTab from "./ToolsTab";
import EnhancedToolsTab from "./EnhancedToolsTab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConnectionStatus } from "@/lib/constants";

// Mock data for demonstration
const mockTools: Tool[] = [
  {
    name: "opt_compositions_tdd_extraction",
    description: "TDD implementation for creating the complete opt_compositions table with advanced SQL methodologies and comprehensive data extraction patterns.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: { type: "string", description: "Target table name" },
        extraction_method: { type: "string", description: "Extraction methodology" },
        validation_rules: { type: "array", description: "Validation rules array" },
      },
    },
  },
  {
    name: "musical_algorithm_classification",
    description: "Algorithm type detection system for musical pattern recognition and analysis with machine learning capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        audio_file: { type: "string", description: "Path to audio file" },
        classification_type: { type: "string", description: "Type of classification" },
      },
    },
  },
  {
    name: "enhanced_metadata_music_json_extraction",
    description: "Advanced JSON metadata extraction from music files with support for multiple formats and embedded information.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Music file path" },
        metadata_fields: { type: "array", description: "Fields to extract" },
      },
    },
  },
  {
    name: "schema_tdd_5_phase_pattern",
    description: "Complete Schema TDD Pattern implementation with 5-phase testing methodology for database schema validation.",
    inputSchema: {
      type: "object",
      properties: {
        schema_file: { type: "string", description: "Schema definition file" },
        test_phases: { type: "array", description: "Test phases to execute" },
        validation_mode: { type: "string", description: "Validation mode" },
      },
    },
  },
  {
    name: "data_validation_comprehensive",
    description: "Comprehensive data validation system with multiple validation strategies and error reporting.",
    inputSchema: {
      type: "object",
      properties: {
        data_source: { type: "string", description: "Data source identifier" },
        validation_rules: { type: "object", description: "Validation rules object" },
      },
    },
  },
  {
    name: "performance_optimization_analyzer",
    description: "Advanced performance analysis tool for database query optimization and bottleneck identification.",
    inputSchema: {
      type: "object",
      properties: {
        query_file: { type: "string", description: "SQL query file" },
        performance_metrics: { type: "array", description: "Metrics to analyze" },
      },
    },
  },
  {
    name: "api_integration_testing_suite",
    description: "Complete API integration testing suite with automated test generation and execution.",
    inputSchema: {
      type: "object",
      properties: {
        api_endpoint: { type: "string", description: "API endpoint URL" },
        test_scenarios: { type: "array", description: "Test scenarios" },
        auth_method: { type: "string", description: "Authentication method" },
      },
    },
  },
  {
    name: "log_analysis_pattern_detection",
    description: "Advanced log analysis system with pattern detection and anomaly identification capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        log_file: { type: "string", description: "Log file path" },
        pattern_types: { type: "array", description: "Pattern types to detect" },
      },
    },
  },
  {
    name: "security_audit_comprehensive",
    description: "Comprehensive security audit tool with vulnerability scanning and compliance checking.",
    inputSchema: {
      type: "object",
      properties: {
        target_system: { type: "string", description: "Target system identifier" },
        audit_scope: { type: "array", description: "Audit scope definition" },
        compliance_standards: { type: "array", description: "Compliance standards" },
      },
    },
  },
  {
    name: "deployment_automation_pipeline",
    description: "Automated deployment pipeline with rollback capabilities and environment management.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_config: { type: "string", description: "Deployment configuration" },
        target_environment: { type: "string", description: "Target environment" },
        rollback_strategy: { type: "string", description: "Rollback strategy" },
      },
    },
  },
];

// Simple toggle component since ui/toggle might not exist
const SimpleToggle: React.FC<{
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: React.ReactNode;
}> = ({ pressed, onPressedChange, children }) => (
  <button
    onClick={() => onPressedChange(!pressed)}
    className={`px-3 py-1 rounded border text-sm font-medium transition-colors ${
      pressed 
        ? "bg-primary text-primary-foreground border-primary" 
        : "bg-background border-border hover:bg-muted"
    }`}
  >
    {children}
  </button>
);

const ToolsTabDemo: React.FC = () => {
  const [useEnhanced, setUseEnhanced] = useState(false);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);

  // Mock functions for demo
  const mockCallTool = async (name: string, params: Record<string, unknown>) => {
    console.log(`Mock call tool: ${name}`, params);
  };

  const mockListTools = () => {
    console.log("Mock list tools");
  };

  const mockClearTools = () => {
    setSelectedTool(null);
    console.log("Mock clear tools");
  };

  const commonProps = {
    tools: mockTools,
    listTools: mockListTools,
    clearTools: mockClearTools,
    callTool: mockCallTool,
    selectedTool,
    setSelectedTool,
    toolResult: null,
    nextCursor: undefined,
    error: null,
    connectionStatus: "connected" as ConnectionStatus,
    selectedServerName: "demo-server",
  };

  return (
    <div className="p-6 bg-background min-h-screen">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Tools Tab Enhancement Demo</h1>
          <p className="text-muted-foreground mb-4">
            This demo shows the improvements requested in{" "}
            <a
              href="https://github.com/modelcontextprotocol/inspector/issues/519"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              GitHub Issue #519
            </a>
            : Collapsible method definitions, category grouping, enhanced search, and apply buttons.
          </p>
          
          <div className="flex items-center space-x-4 mb-4">
            <SimpleToggle
              pressed={useEnhanced}
              onPressedChange={setUseEnhanced}
            >
              {useEnhanced ? "Enhanced View" : "Original View"}
            </SimpleToggle>
            <span className="text-sm text-muted-foreground">
              {useEnhanced
                ? "✨ Enhanced: Collapsible, categorized, with apply buttons"
                : "📋 Original: Simple list view"}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 text-sm">
            <div className="bg-card p-4 rounded-lg border">
              <h3 className="font-semibold mb-2">Original ToolsTab Issues:</h3>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Simple list becomes unwieldy with 22+ tools</li>
                <li>No categorization or grouping</li>
                <li>Full descriptions always visible</li>
                <li>No quick "apply" action</li>
                <li>Basic search only</li>
              </ul>
            </div>
            
            <div className="bg-card p-4 rounded-lg border">
              <h3 className="font-semibold mb-2">Enhanced ToolsTab Features:</h3>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>✅ Collapsible tool definitions</li>
                <li>✅ Category grouping (auto-detected)</li>
                <li>✅ Enhanced search & filtering</li>
                <li>✅ "Apply Method" buttons</li>
                <li>✅ Better visual hierarchy</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="border rounded-lg bg-card">
          {useEnhanced ? (
            <EnhancedToolsTab {...commonProps} />
          ) : (
            <ToolsTab {...commonProps} />
          )}
        </div>

        <div className="mt-6 p-4 bg-muted rounded-lg">
          <h3 className="font-semibold mb-2">Implementation Notes:</h3>
          <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
            <li>
              <strong>Category Detection:</strong> Automatically extracts categories from tool names using patterns like "prefix_category_action"
            </li>
            <li>
              <strong>Collapsible UI:</strong> Uses existing patterns from the codebase (ChevronDown/ChevronRight icons)
            </li>
            <li>
              <strong>Apply Buttons:</strong> Directly select tools and scroll to the tool runner for immediate use
            </li>
            <li>
              <strong>Enhanced Search:</strong> Searches both tool names and descriptions, with category filtering
            </li>
            <li>
              <strong>Visual Hierarchy:</strong> Clear category headers, indented tool cards, and better spacing
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default ToolsTabDemo; 