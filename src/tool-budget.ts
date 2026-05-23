/**
 * Per-turn tool-call budget when a handbook was injected this turn.
 *
 * Purpose: if autoMM injected a handbook (the answer is in context), cap the
 * number of tool calls the model can make this turn. On budget exhaustion,
 * `decide` returns a block result; pi's beforeToolCall wiring then surfaces
 * the reason text as an error tool result, nudging the model to answer from
 * the handbook content instead of continuing to dig.
 *
 * State is scoped per turn (mmInjectedThisTurn + count). Reset via
 * `beginTurn()` from a `before_agent_start` or `turn_start` hook.
 */

export interface ToolBudgetConfig {
  /** Hard cap on tool calls per turn when a handbook was injected. <=0 disables enforcement. */
  autoMMToolCallBudget: number;
}

export interface ToolBudgetDecision {
  /** Block the tool call. Pi turns this into an error tool result containing `reason`. */
  block: boolean;
  reason?: string;
}

export class ToolBudget {
  private count = 0;
  private mmInjectedThisTurn = false;

  /** Reset state at the start of a turn. */
  beginTurn(): void {
    this.count = 0;
    this.mmInjectedThisTurn = false;
  }

  /** Flag that autoMM injected a handbook for the current turn. */
  markMMInjected(): void {
    this.mmInjectedThisTurn = true;
  }

  /** True if a handbook was injected this turn. */
  get isMMInjectedThisTurn(): boolean {
    return this.mmInjectedThisTurn;
  }

  /** Current tool-call count this turn (allowed calls only — blocked calls don't count). */
  get currentCount(): number {
    return this.count;
  }

  /**
   * Decide whether the current tool call should proceed.
   * Returns block=true with a reason when budget is exhausted; otherwise
   * increments the counter and returns block=false.
   */
  decide(config: ToolBudgetConfig): ToolBudgetDecision {
    if (!this.mmInjectedThisTurn) {
      return { block: false };
    }
    if (config.autoMMToolCallBudget <= 0) {
      return { block: false };
    }
    if (this.count >= config.autoMMToolCallBudget) {
      return {
        block: true,
        reason:
          `Tool-call budget exhausted (${config.autoMMToolCallBudget} calls used on this turn). ` +
          `Hindsight injected a handbook for this turn — answer from the handbook content ` +
          `already in your context. If the handbook does not cover the question, say so explicitly ` +
          `and explain what's missing rather than continuing to invoke tools.`,
      };
    }
    this.count++;
    return { block: false };
  }
}
