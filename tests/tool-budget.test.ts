/**
 * Unit tests for the per-turn tool-call budget that activates when autoMM
 * injected a handbook.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { ToolBudget } from "../src/tool-budget";

describe("ToolBudget", () => {
  let b: ToolBudget;

  beforeEach(() => {
    b = new ToolBudget();
  });

  it("never blocks when no MM was injected this turn", () => {
    const config = { autoMMToolCallBudget: 5 };
    for (let i = 0; i < 100; i++) {
      const d = b.decide(config);
      expect(d.block).toBe(false);
    }
  });

  it("never blocks when budget is 0 (disabled), even if MM injected", () => {
    b.markMMInjected();
    const config = { autoMMToolCallBudget: 0 };
    for (let i = 0; i < 100; i++) {
      const d = b.decide(config);
      expect(d.block).toBe(false);
    }
  });

  it("never blocks when budget is negative", () => {
    b.markMMInjected();
    const config = { autoMMToolCallBudget: -1 };
    for (let i = 0; i < 5; i++) {
      expect(b.decide(config).block).toBe(false);
    }
  });

  it("allows exactly `budget` calls then blocks", () => {
    b.markMMInjected();
    const config = { autoMMToolCallBudget: 3 };
    // 3 allowed
    expect(b.decide(config).block).toBe(false);
    expect(b.decide(config).block).toBe(false);
    expect(b.decide(config).block).toBe(false);
    // 4th and beyond blocked
    const blocked1 = b.decide(config);
    expect(blocked1.block).toBe(true);
    expect(blocked1.reason).toBeDefined();
    expect(blocked1.reason).toContain("budget exhausted");
    expect(blocked1.reason).toContain("3");
    expect(b.decide(config).block).toBe(true);
  });

  it("blocked calls do not increment the counter", () => {
    b.markMMInjected();
    const config = { autoMMToolCallBudget: 2 };
    b.decide(config); // 1
    b.decide(config); // 2
    expect(b.currentCount).toBe(2);
    b.decide(config); // blocked
    expect(b.currentCount).toBe(2); // still 2
    b.decide(config); // blocked
    expect(b.currentCount).toBe(2);
  });

  it("beginTurn resets count and MM flag", () => {
    b.markMMInjected();
    const config = { autoMMToolCallBudget: 1 };
    b.decide(config);
    expect(b.decide(config).block).toBe(true); // exhausted

    b.beginTurn();
    expect(b.currentCount).toBe(0);
    expect(b.isMMInjectedThisTurn).toBe(false);
    // After reset (without re-marking MM), no blocking
    for (let i = 0; i < 10; i++) {
      expect(b.decide(config).block).toBe(false);
    }
  });

  it("reason text references the handbook and discourages further tool calls", () => {
    b.markMMInjected();
    const config = { autoMMToolCallBudget: 1 };
    b.decide(config);
    const blocked = b.decide(config);
    expect(blocked.block).toBe(true);
    expect(blocked.reason?.toLowerCase()).toContain("handbook");
    // Should advise the model to either answer from context or say what's missing
    expect(blocked.reason?.toLowerCase()).toMatch(/answer from|already in your context/);
  });

  it("currentCount is 0 after construction", () => {
    expect(b.currentCount).toBe(0);
    expect(b.isMMInjectedThisTurn).toBe(false);
  });

  it("markMMInjected sets the flag", () => {
    expect(b.isMMInjectedThisTurn).toBe(false);
    b.markMMInjected();
    expect(b.isMMInjectedThisTurn).toBe(true);
  });

  it("repeated markMMInjected within a turn is idempotent", () => {
    b.markMMInjected();
    b.markMMInjected();
    b.markMMInjected();
    expect(b.isMMInjectedThisTurn).toBe(true);
    const config = { autoMMToolCallBudget: 1 };
    expect(b.decide(config).block).toBe(false);
    expect(b.decide(config).block).toBe(true);
  });

  it("budget can be changed mid-turn (config-driven)", () => {
    b.markMMInjected();
    // First two calls under budget 5
    expect(b.decide({ autoMMToolCallBudget: 5 }).block).toBe(false);
    expect(b.decide({ autoMMToolCallBudget: 5 }).block).toBe(false);
    // Tighten budget to 2 — already at count=2, next call blocks
    expect(b.decide({ autoMMToolCallBudget: 2 }).block).toBe(true);
    // Loosen back to 5 — next call passes (still at count=2)
    expect(b.decide({ autoMMToolCallBudget: 5 }).block).toBe(false);
  });
});
