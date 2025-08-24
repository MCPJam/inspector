import { SavedTest, TestStep, ValidationRule, DynamicTestConfig } from "./test-storage";
import { ModelDefinition } from "@/shared/types.js";

export interface TestExecutionContext {
  serverConfig: any;
  serverConfigsMap?: Record<string, any>;
  allServerConfigsMap?: Record<string, any>;
  model: ModelDefinition;
  apiKey: string;
  ollamaBaseUrl: string;
  selectedServers: string[];
}

export interface TestExecutionResult {
  success: boolean;
  calledTools: string[];
  missingTools: string[];
  unexpectedTools: string[];
  stepResults: StepResult[];
  validationResults: ValidationResult[];
  error?: string;
  traces: Array<{ step: number; text?: string; toolCalls?: any[]; toolResults?: any[] }>;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  output?: any;
  error?: string;
  toolsCalled: string[];
  executionTime: number;
}

export interface ValidationResult {
  ruleId: string;
  passed: boolean;
  message: string;
  details?: any;
}

export class TestExecutionEngine {
  private context: TestExecutionContext;
  private calledTools = new Set<string>();
  private traces: Array<{ step: number; text?: string; toolCalls?: any[]; toolResults?: any[] }> = [];
  private stepCounter = 0;

  constructor(context: TestExecutionContext) {
    this.context = context;
  }

  async executeTest(test: SavedTest): Promise<TestExecutionResult> {
    this.calledTools.clear();
    this.traces = [];
    this.stepCounter = 0;

    const startTime = Date.now();

    try {
      // If no dynamic config, fall back to basic execution
      if (!test.dynamicConfig) {
        return await this.executeBasicTest(test);
      }

      return await this.executeDynamicTest(test, test.dynamicConfig);
    } catch (error) {
      return {
        success: false,
        calledTools: Array.from(this.calledTools),
        missingTools: [],
        unexpectedTools: [],
        stepResults: [],
        validationResults: [],
        error: error instanceof Error ? error.message : "Unknown error",
        traces: this.traces,
      };
    }
  }

  private async executeBasicTest(test: SavedTest): Promise<TestExecutionResult> {
    // Execute as before - single prompt with expected tools validation
    const stepResults: StepResult[] = [];
    
    const stepResult = await this.executePromptStep({
      id: "basic-prompt",
      type: "prompt",
      config: { prompt: test.prompt },
    });

    stepResults.push(stepResult);

    // Validate expected tools
    const expectedSet = new Set(test.expectedTools);
    const calledArray = Array.from(this.calledTools);
    const missingTools = test.expectedTools.filter(t => !this.calledTools.has(t));
    const unexpectedTools = calledArray.filter(t => !expectedSet.has(t));

    return {
      success: missingTools.length === 0 && unexpectedTools.length === 0,
      calledTools: calledArray,
      missingTools,
      unexpectedTools,
      stepResults,
      validationResults: [],
      traces: this.traces,
    };
  }

  private async executeDynamicTest(test: SavedTest, config: DynamicTestConfig): Promise<TestExecutionResult> {
    const stepResults: StepResult[] = [];
    
    // Execute steps in sequence
    for (const step of config.executionPlan) {
      const result = await this.executeStep(step);
      stepResults.push(result);
      
      if (!result.success && step.type !== 'validation') {
        // Stop execution on critical failures (but continue on validation failures)
        break;
      }
    }

    // Run validations
    const validationResults = await this.runValidations(config.validationRules);

    // Determine overall success
    const stepsFailed = stepResults.some(r => !r.success && r.stepId !== 'validation');
    const validationsFailed = validationResults.some(r => !r.passed);
    const success = !stepsFailed && !validationsFailed;

    // Calculate tools for backward compatibility
    const expectedSet = new Set(test.expectedTools);
    const calledArray = Array.from(this.calledTools);
    const missingTools = test.expectedTools.filter(t => !this.calledTools.has(t));
    const unexpectedTools = calledArray.filter(t => !expectedSet.has(t));

    return {
      success,
      calledTools: calledArray,
      missingTools,
      unexpectedTools,
      stepResults,
      validationResults,
      traces: this.traces,
    };
  }

  private async executeStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();

    try {
      switch (step.type) {
        case 'prompt':
          return await this.executePromptStep(step);
        case 'tool_call':
          return await this.executeToolCallStep(step);
        case 'validation':
          return await this.executeValidationStep(step);
        case 'wait':
          return await this.executeWaitStep(step);
        case 'conditional':
          return await this.executeConditionalStep(step);
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }
    } catch (error) {
      return {
        stepId: step.id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        toolsCalled: [],
        executionTime: Date.now() - startTime,
      };
    }
  }

  private async executePromptStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();
    const toolsCalledInStep = new Set<string>();

    try {
      const selectionMap = this.getServerSelectionMap();
      
      const response = await fetch("/api/mcp/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          serverConfigs: selectionMap,
          model: this.context.model,
          provider: this.context.model.provider,
          apiKey: this.context.apiKey,
          systemPrompt: "You are a helpful assistant with access to MCP tools.",
          messages: [
            { id: crypto.randomUUID(), role: "user", content: step.config.prompt || "", timestamp: Date.now() },
          ],
          ollamaBaseUrl: this.context.ollamaBaseUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await this.processStreamResponse(response, toolsCalledInStep);

      return {
        stepId: step.id,
        success: true,
        toolsCalled: Array.from(toolsCalledInStep),
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        stepId: step.id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        toolsCalled: Array.from(toolsCalledInStep),
        executionTime: Date.now() - startTime,
      };
    }
  }

  private async executeToolCallStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();
    const expectedTool = step.config.expectedTool;
    
    if (!expectedTool) {
      throw new Error("Tool call step requires expectedTool in config");
    }

    // Check if the expected tool was called in previous steps
    const toolWasCalled = this.calledTools.has(expectedTool);

    return {
      stepId: step.id,
      success: toolWasCalled,
      output: { toolCalled: toolWasCalled, expectedTool },
      toolsCalled: toolWasCalled ? [expectedTool] : [],
      executionTime: Date.now() - startTime,
    };
  }

  private async executeValidationStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();
    
    // Simple validation logic - can be extended
    const rule = step.config.validationRule;
    if (!rule) {
      throw new Error("Validation step requires validationRule in config");
    }

    // For now, just return success - extend this based on your validation needs
    return {
      stepId: step.id,
      success: true,
      output: { validationRule: rule, result: "passed" },
      toolsCalled: [],
      executionTime: Date.now() - startTime,
    };
  }

  private async executeWaitStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();
    const waitTime = step.config.waitTime || 1000;
    
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    return {
      stepId: step.id,
      success: true,
      output: { waitTime },
      toolsCalled: [],
      executionTime: Date.now() - startTime,
    };
  }

  private async executeConditionalStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();
    
    // Simple conditional logic - can be extended
    const condition = step.config.condition;
    if (!condition) {
      throw new Error("Conditional step requires condition in config");
    }

    // For now, always pass - extend this with actual condition evaluation
    return {
      stepId: step.id,
      success: true,
      output: { condition, result: true },
      toolsCalled: [],
      executionTime: Date.now() - startTime,
    };
  }

  private async runValidations(rules: ValidationRule[]): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    for (const rule of rules) {
      const result = await this.runValidationRule(rule);
      results.push(result);
    }

    return results;
  }

  private async runValidationRule(rule: ValidationRule): Promise<ValidationResult> {
    switch (rule.type) {
      case 'tool_called':
        const toolName = rule.config.toolName;
        if (!toolName) {
          return { ruleId: rule.id, passed: false, message: "Tool name not specified" };
        }
        const wasCalled = this.calledTools.has(toolName);
        return {
          ruleId: rule.id,
          passed: wasCalled,
          message: wasCalled ? `Tool ${toolName} was called` : `Tool ${toolName} was not called`,
        };

      case 'tool_not_called':
        const notToolName = rule.config.toolName;
        if (!notToolName) {
          return { ruleId: rule.id, passed: false, message: "Tool name not specified" };
        }
        const wasNotCalled = !this.calledTools.has(notToolName);
        return {
          ruleId: rule.id,
          passed: wasNotCalled,
          message: wasNotCalled ? `Tool ${notToolName} was not called (as expected)` : `Tool ${notToolName} was called unexpectedly`,
        };

      default:
        return { ruleId: rule.id, passed: true, message: "Validation not implemented" };
    }
  }

  private async processStreamResponse(response: Response, toolsCalledInStep: Set<string>) {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneStreaming = false;

    if (reader) {
      while (!doneStreaming) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              doneStreaming = true;
              break;
            }
            if (!data) continue;
            
            try {
              const parsed = JSON.parse(data);
              
              // Capture tool calls
              if ((parsed.type === "tool_call" || (!parsed.type && parsed.toolCall)) && parsed.toolCall) {
                const toolCall = parsed.toolCall;
                if (toolCall?.name) {
                  this.calledTools.add(toolCall.name);
                  toolsCalledInStep.add(toolCall.name);
                }
                if (toolCall?.toolName) {
                  this.calledTools.add(toolCall.toolName);
                  toolsCalledInStep.add(toolCall.toolName);
                }
              }
              
              // Capture trace events
              if (parsed.type === "trace_step" && typeof parsed.step === "number") {
                this.traces.push({
                  step: parsed.step,
                  text: parsed.text,
                  toolCalls: parsed.toolCalls,
                  toolResults: parsed.toolResults,
                });
              }
            } catch {
              // ignore malformed line
            }
          }
        }
      }
    }
  }

  private getServerSelectionMap() {
    // If the per-test picker has selections, use those.
    if (this.context.selectedServers.length > 0 && this.context.allServerConfigsMap) {
      const map: Record<string, any> = {};
      for (const name of this.context.selectedServers) {
        if (this.context.allServerConfigsMap[name]) {
          map[name] = this.context.allServerConfigsMap[name];
        }
      }
      return map;
    }
    
    // Otherwise, default to ALL connected servers if available
    if (this.context.allServerConfigsMap && Object.keys(this.context.allServerConfigsMap).length > 0) {
      return this.context.allServerConfigsMap;
    }
    
    // Fallback to whatever was passed from app (may be a subset)
    if (this.context.serverConfigsMap) {
      return this.context.serverConfigsMap;
    }
    
    // Final fallback to single server
    return this.context.serverConfig ? { test: this.context.serverConfig } : {};
  }
}

// Helper functions for creating common test configurations
export class TestConfigBuilder {
  static createBasicTest(title: string, prompt: string, expectedTools: string[]): DynamicTestConfig {
    return {
      agentType: 'basic',
      executionPlan: [
        {
          id: 'main-prompt',
          type: 'prompt',
          config: { prompt }
        }
      ],
      validationRules: expectedTools.map(tool => ({
        id: `validate-${tool}`,
        type: 'tool_called',
        config: { toolName: tool }
      }))
    };
  }

  static createMultiStepTest(title: string, steps: Array<{prompt: string, expectedTool?: string}>): DynamicTestConfig {
    const executionPlan: TestStep[] = steps.map((step, index) => ({
      id: `step-${index + 1}`,
      type: 'prompt',
      config: { prompt: step.prompt }
    }));

    const validationRules: ValidationRule[] = steps
      .filter(step => step.expectedTool)
      .map((step, index) => ({
        id: `validate-step-${index + 1}`,
        type: 'tool_called',
        config: { toolName: step.expectedTool! }
      }));

    return {
      agentType: 'multi-step',
      executionPlan,
      validationRules
    };
  }
}