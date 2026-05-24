/**
 * Unit tests for session metadata management.
 */

import { describe, expect, it } from "bun:test";
import { type GateDecision, getHindsightMeta, shouldSessionBeRetained } from "../src/meta";

type MetaEntry = Parameters<typeof getHindsightMeta>[0][number];

const sampleGate: GateDecision = {
  status: "held",
  decidedAt: "2026-05-01T00:00:00Z",
  decidedBy: "operator",
  reason: "needs review",
};

describe("getHindsightMeta", () => {
  it("returns null when no hindsight-meta entries exist", () => {
    const entries: MetaEntry[] = [
      { type: "message" },
      { type: "custom", customType: "other-type", data: { foo: "bar" } },
    ];
    expect(getHindsightMeta(entries)).toBeNull();
  });

  it("returns the latest hindsight-meta entry data", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      { type: "message" },
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ retained: false });
  });

  it("returns single hindsight-meta entry", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true, tags: ["test"] } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ retained: true, tags: ["test"] });
  });

  it("returns null for hindsight-meta entry with undefined data", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: undefined },
    ];
    expect(getHindsightMeta(entries)).toBeNull();
  });

  it("returns null for empty entries array", () => {
    expect(getHindsightMeta([])).toBeNull();
  });

  it("returns meta with tags only", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { tags: ["topic:ai"] } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ tags: ["topic:ai"] });
  });

  it("returns meta with gate when set alongside retained", () => {
    const entries: MetaEntry[] = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, gate: sampleGate },
      },
    ];
    expect(getHindsightMeta(entries)).toEqual({ retained: true, gate: sampleGate });
  });

  it("uses the latest entry — later entry without retained shadows the prior retained", () => {
    // Documents the existing latest-entry semantics. Gate-aware callers should
    // use getGateDecision (which scans for the field) rather than this helper.
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      { type: "custom", customType: "hindsight-meta", data: { gate: sampleGate } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ gate: sampleGate });
  });
});

describe("shouldSessionBeRetained", () => {
  it("returns true by default when retainSessionsByDefault is true", () => {
    expect(shouldSessionBeRetained([], { retainSessionsByDefault: true })).toBe(true);
  });

  it("returns false by default when retainSessionsByDefault is false", () => {
    expect(shouldSessionBeRetained([], { retainSessionsByDefault: false })).toBe(false);
  });

  it("returns retained value from meta when present", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: true })).toBe(false);
  });

  it("returns retained: true from meta even when default is false", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: false })).toBe(true);
  });

  it("falls back to config when retained is undefined in meta", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { tags: ["test"] } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: false })).toBe(false);
  });

  it("uses latest meta entry when multiple exist", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: true })).toBe(false);
  });
});
