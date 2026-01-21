export interface EvalsSuiteConfig {
  name?: string;
}

export interface EvalRunResult {
  iterations: number;
  successes: number;
  failures: number;
  results: boolean[];
  tokenUsage: {
    total: number;
    perIteration: number[];
  };
}

interface RunConfig {
  func: () => boolean | Promise<boolean>;
  iterations: number;
}

export class EvalsSuite {
  private name: string;
  private lastRunResult: EvalRunResult | null = null;

  constructor(config?: EvalsSuiteConfig) {
    this.name = config?.name ?? "EvalsSuite";
  }

  async run(config: RunConfig): Promise<EvalRunResult> {
    const results: boolean[] = [];
    const tokenUsagePerIteration: number[] = [];
    let successes = 0;
    let failures = 0;

    for (let i = 0; i < config.iterations; i++) {
      try {
        const result = await config.func();
        results.push(result);
        if (result) {
          successes++;
        } else {
          failures++;
        }
        // TODO: Track actual token usage from TestAgent
        tokenUsagePerIteration.push(0);
      } catch {
        results.push(false);
        failures++;
        tokenUsagePerIteration.push(0);
      }
    }

    this.lastRunResult = {
      iterations: config.iterations,
      successes,
      failures,
      results,
      tokenUsage: {
        total: tokenUsagePerIteration.reduce((a, b) => a + b, 0),
        perIteration: tokenUsagePerIteration,
      },
    };

    return this.lastRunResult;
  }

  accuracy(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.successes / this.lastRunResult.iterations;
  }

  recall(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // In a basic eval context, recall equals accuracy
    // For more complex scenarios, this would need ground truth labels
    return this.accuracy();
  }

  precision(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // In a basic eval context, precision equals accuracy
    // For more complex scenarios, this would need ground truth labels
    return this.accuracy();
  }

  truePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // TPR = TP / (TP + FN) = same as recall in basic context
    return this.recall();
  }

  falsePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // FPR = FP / (FP + TN)
    // In basic eval context, we consider failures as false positives
    return this.lastRunResult.failures / this.lastRunResult.iterations;
  }

  averageTokenUse(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    if (this.lastRunResult.iterations === 0) {
      return 0;
    }
    return this.lastRunResult.tokenUsage.total / this.lastRunResult.iterations;
  }

  getResults(): EvalRunResult | null {
    return this.lastRunResult;
  }

  getName(): string {
    return this.name;
  }
}
