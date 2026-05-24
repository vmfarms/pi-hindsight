/**
 * Unit tests for the retention-gate state machine.
 *
 * Covers meta.ts gate helpers (getGateDecision / setGateDecision),
 * gate.ts transitions (holdSession / discardSession / promoteSession),
 * and gate command listing (listHeldSessions).
 *
 * The transition tests use a temp PI_CODING_AGENT_DIR so symlink writes
 * don't leak into the developer's real agent directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTargetOptions, listHeldSessions } from "../src/commands/gate";
import {
  discardHeldSession,
  discardSession,
  getDiscardedDir,
  getReviewQueueDir,
  holdSession,
  promoteSession,
} from "../src/gate";
import {
  type GateDecision,
  getGateDecision,
  type HindsightMeta,
  setGateDecision,
} from "../src/meta";
import {
  enqueueAutoMessage,
  enqueueToolMessage,
  getQueuePath,
  getToolQueuePath,
} from "../src/queue";
import {
  type CapturedExtension,
  createMockClient,
  createMockContext,
  createMockPi,
  setupTempAgentDir,
  testConfig,
} from "./fixtures";

type MetaEntry = { type: string; customType?: string; data?: unknown };

const agentDir = setupTempAgentDir("gate");

const gateConfig = {
  ...testConfig,
  retentionGate: { mode: "interactive-menu", reviewQueuePath: null, discardedPath: null },
} as const;

describe("getGateDecision", () => {
  it("returns undefined when no entries set a gate", () => {
    const entries: MetaEntry[] = [
      { type: "message" },
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
    ];
    expect(getGateDecision(entries)).toBeUndefined();
  });

  it("returns the latest gate decision", () => {
    const earlier: GateDecision = {
      status: "pending",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "auto",
    };
    const later: GateDecision = {
      status: "held",
      decidedAt: "2026-01-02T00:00:00Z",
      decidedBy: "operator",
      reason: "needs review",
    };
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { gate: earlier } },
      { type: "message" },
      { type: "custom", customType: "hindsight-meta", data: { gate: later } },
    ];
    expect(getGateDecision(entries)).toEqual(later);
  });

  it("ignores hindsight-meta entries that have no gate field", () => {
    const earlier: GateDecision = {
      status: "pending",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "auto",
    };
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { gate: earlier } },
      // Later tag-only update — must NOT clobber the prior gate.
      { type: "custom", customType: "hindsight-meta", data: { tags: ["topic:ai"] } },
    ];
    expect(getGateDecision(entries)).toEqual(earlier);
  });

  it("ignores non-hindsight-meta entries with a gate field", () => {
    const stray: GateDecision = {
      status: "promoted",
      decidedAt: "2026-01-03T00:00:00Z",
      decidedBy: "operator",
    };
    const entries: MetaEntry[] = [
      { type: "custom", customType: "other-thing", data: { gate: stray } },
    ];
    expect(getGateDecision(entries)).toBeUndefined();
  });

  it("returns undefined for an empty entries array", () => {
    expect(getGateDecision([])).toBeUndefined();
  });
});

describe("setGateDecision", () => {
  const gate: GateDecision = {
    status: "promoted",
    decidedAt: "2026-01-04T00:00:00Z",
    decidedBy: "operator",
  };

  it("returns a payload with only gate when no existing meta", () => {
    expect(setGateDecision(gate)).toEqual({ gate });
  });

  it("carries forward existing retained when present", () => {
    const existing: HindsightMeta = { retained: false };
    expect(setGateDecision(gate, existing)).toEqual({ retained: false, gate });
  });

  it("carries forward non-empty tags but drops empty tags", () => {
    expect(setGateDecision(gate, { tags: ["topic:foo"] })).toEqual({
      tags: ["topic:foo"],
      gate,
    });
    expect(setGateDecision(gate, { tags: [] })).toEqual({ gate });
  });

  it("does not include retained when existing meta has it undefined", () => {
    expect(setGateDecision(gate, {})).toEqual({ gate });
  });
});

describe("holdSession", () => {
  let pi: ExtensionAPI & CapturedExtension;
  let sessionFile: string;

  beforeEach(() => {
    pi = createMockPi();
    const sessionDir = join(agentDir, "sessions");
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    sessionFile = join(sessionDir, "held-session.jsonl");
    writeFileSync(sessionFile, '{"type":"session","id":"held-session"}\n', "utf8");
  });

  it("appends a 'held' gate decision and creates a symlink in review-queue/", async () => {
    const ctx = createMockContext({ _sessionId: "held-session" });
    (ctx.sessionManager.getSessionFile as () => string) = () => sessionFile;
    (ctx.sessionManager.getSessionId as () => string) = () => "held-session";

    const result = await holdSession(pi, ctx, gateConfig, "manual defer");

    expect(result.ok).toBe(true);
    expect(result.linkPath).toBeDefined();
    expect(pi.appendedEntries.length).toBe(1);
    const data = pi.appendedEntries[0]?.data as HindsightMeta;
    expect(data.gate?.status).toBe("held");
    expect(data.gate?.reason).toBe("manual defer");

    // Symlink resolves to the session file.
    const linkPath = result.linkPath ?? "";
    expect(existsSync(linkPath)).toBe(true);
    expect(readlinkSync(linkPath)).toBe(sessionFile);
  });

  it("falls back to a status-only update when no session JSONL exists yet", async () => {
    const ctx = createMockContext({ _sessionId: "no-file-session" });
    (ctx.sessionManager.getSessionFile as () => null) = () => null;
    (ctx.sessionManager.getSessionId as () => string) = () => "no-file-session";

    const result = await holdSession(pi, ctx, gateConfig, "no file yet");

    expect(result.ok).toBe(true);
    expect(result.linkPath).toBeUndefined();
    expect(pi.appendedEntries.length).toBe(1);
  });

  it("returns an error when no active session id", async () => {
    const ctx = createMockContext();
    (ctx.sessionManager.getSessionId as () => undefined) = () => undefined;

    const result = await holdSession(pi, ctx, gateConfig);
    expect(result.ok).toBe(false);
    expect(pi.appendedEntries.length).toBe(0);
  });
});

describe("discardSession", () => {
  let pi: ExtensionAPI & CapturedExtension;
  let sessionFile: string;
  const sessionId = "discard-session";

  beforeEach(() => {
    pi = createMockPi();
    const sessionDir = join(agentDir, "sessions");
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, `{"type":"session","id":"${sessionId}"}\n`, "utf8");

    // Seed queue files so we can confirm cleanup.
    enqueueAutoMessage(sessionId, {
      entry: { type: "message", message: { role: "user", content: "hi" } },
      store_method: "auto",
    });
    enqueueToolMessage(sessionId, {
      content: "tool-retain",
      timestamp: new Date().toISOString(),
      store_method: "tool",
    });
  });

  afterEach(() => {
    // Best-effort cleanup of any test residue.
    for (const p of [getQueuePath(sessionId), getToolQueuePath(sessionId)]) {
      try {
        if (existsSync(p)) {
          require("node:fs").unlinkSync(p);
        }
      } catch {
        /* ignore */
      }
    }
  });

  it("appends a 'discarded' decision, removes queues, and symlinks into discarded/", async () => {
    const ctx = createMockContext({ _sessionId: sessionId });
    (ctx.sessionManager.getSessionFile as () => string) = () => sessionFile;
    (ctx.sessionManager.getSessionId as () => string) = () => sessionId;

    expect(existsSync(getQueuePath(sessionId))).toBe(true);
    expect(existsSync(getToolQueuePath(sessionId))).toBe(true);

    const result = await discardSession(pi, ctx, gateConfig, "test reject", ["mode:foo"]);
    expect(result.ok).toBe(true);
    expect(result.linkPath).toBeDefined();

    const data = pi.appendedEntries[0]?.data as HindsightMeta;
    expect(data.gate?.status).toBe("discarded");
    expect(data.gate?.failureModes).toEqual(["mode:foo"]);

    expect(existsSync(getQueuePath(sessionId))).toBe(false);
    expect(existsSync(getToolQueuePath(sessionId))).toBe(false);

    const linkPath = result.linkPath ?? "";
    expect(readlinkSync(linkPath)).toBe(sessionFile);
    expect(linkPath.includes(getDiscardedDir(gateConfig.retentionGate))).toBe(true);
  });
});

describe("promoteSession", () => {
  it("appends a 'promoted' decision and short-circuits to upsert", async () => {
    const pi = createMockPi();
    const ctx = createMockContext({ _sessionId: "promote-session" });
    // Force parseAndUpsertSession into its early-exit "warning" branch so we
    // don't need a real on-disk session file. The early-exit still returns a
    // {message, level} object so promoteSession finishes deterministically.
    (ctx.sessionManager.getSessionFile as () => string) = () => "/nonexistent/path.jsonl";
    (ctx.sessionManager.getSessionId as () => string) = () => "promote-session";
    const client = createMockClient();

    const result = await promoteSession(pi, ctx, gateConfig, client, "looks good");
    // result.ok depends on parseAndUpsertSession outcome; the gate decision must
    // still have been appended regardless of upsert success.
    expect(pi.appendedEntries.length).toBeGreaterThanOrEqual(1);
    const data = pi.appendedEntries[0]?.data as HindsightMeta;
    expect(data.gate?.status).toBe("promoted");
    expect(data.gate?.reason).toBe("looks good");
    // For the no-file branch parseAndUpsertSession returns a warning result;
    // promoteSession reports !ok in that case.
    expect(typeof result.message).toBe("string");
  });
});

describe("listHeldSessions", () => {
  it("returns rows sorted newest-first and resolves symlink targets", async () => {
    // Use a dedicated subdir so previous tests' holdSession symlinks don't
    // pollute this scan.
    const reviewDir = join(agentDir, "list-test-review-queue");
    mkdirSync(reviewDir, { recursive: true });

    const sessionsDir = join(agentDir, "sessions-fixture");
    mkdirSync(sessionsDir, { recursive: true });

    const aPath = join(sessionsDir, "a.jsonl");
    const bPath = join(sessionsDir, "b.jsonl");
    writeFileSync(aPath, '{"type":"session","id":"a"}\n', "utf8");
    writeFileSync(bPath, '{"type":"session","id":"b"}\n', "utf8");

    // Make b's mtime newer than a's so we know what sort order to expect.
    const now = Date.now();
    require("node:fs").utimesSync(aPath, new Date(now - 60_000), new Date(now - 60_000));
    require("node:fs").utimesSync(bPath, new Date(now), new Date(now));

    const linkA = join(reviewDir, "a.jsonl");
    const linkB = join(reviewDir, "b.jsonl");
    require("node:fs").symlinkSync(aPath, linkA);
    require("node:fs").symlinkSync(bPath, linkB);

    const rows = listHeldSessions(reviewDir);
    expect(rows.length).toBe(2);
    expect(rows[0]?.sessionId).toBe("b");
    expect(rows[1]?.sessionId).toBe("a");
    expect(rows[0]?.targetPath).toBe(bPath);
  });

  it("returns an empty array when the review-queue directory does not exist", () => {
    const missing = join(agentDir, "no-such-dir");
    expect(listHeldSessions(missing)).toEqual([]);
  });
});

describe("discardHeldSession", () => {
  it("removes the review-queue symlink and places one in discarded/", async () => {
    const reviewDir = join(agentDir, "extensions", "pi-hindsight", "review-queue");
    mkdirSync(reviewDir, { recursive: true });

    const sessionsDir = join(agentDir, "held-discard-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionId = "held-discard-001";
    const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, `{"type":"session","id":"${sessionId}"}\n`, "utf8");

    const heldLink = join(reviewDir, `${sessionId}.jsonl`);
    require("node:fs").symlinkSync(sessionPath, heldLink);
    expect(existsSync(heldLink)).toBe(true);

    const result = discardHeldSession(gateConfig, sessionId, sessionPath, "off-session reject");
    expect(result.ok).toBe(true);
    expect(result.linkPath).toBeDefined();

    // Stale review-queue link is gone, discarded/ link points at the source.
    expect(existsSync(heldLink)).toBe(false);
    const discardedLink = result.linkPath ?? "";
    expect(require("node:fs").readlinkSync(discardedLink)).toBe(sessionPath);
  });
});

describe("on-session discard clears the prior review-queue symlink", () => {
  it("removes <sessionId>.jsonl from review-queue when discarding the current session", async () => {
    const pi = createMockPi();
    const reviewDir = join(agentDir, "extensions", "pi-hindsight", "review-queue");
    mkdirSync(reviewDir, { recursive: true });

    const sessionsDir = join(agentDir, "on-session-cleanup");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionId = "on-session-cleanup-001";
    const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, `{"type":"session","id":"${sessionId}"}\n`, "utf8");

    // Simulate a prior default-defer: place a held symlink for this session id.
    const heldLink = join(reviewDir, `${sessionId}.jsonl`);
    require("node:fs").symlinkSync(sessionPath, heldLink);
    expect(existsSync(heldLink)).toBe(true);

    const ctx = createMockContext({ _sessionId: sessionId });
    (ctx.sessionManager.getSessionFile as () => string) = () => sessionPath;
    (ctx.sessionManager.getSessionId as () => string) = () => sessionId;

    const result = await discardSession(pi, ctx, gateConfig, "operator override");
    expect(result.ok).toBe(true);
    expect(existsSync(heldLink)).toBe(false);
  });
});

describe("buildTargetOptions", () => {
  const now = new Date("2026-05-24T12:00:00Z");
  const sessionSummary = {
    project: "pi-hindsight",
    displayName: "Implementing the gate state machine",
    messageCount: 12,
  };
  const heldRow = {
    sessionId: "abcdef1234567890",
    linkPath: "/agent/review-queue/abcdef1234567890.jsonl",
    targetPath: "/agent/sessions/abcdef1234567890.jsonl",
    modifiedAt: new Date("2026-05-24T09:00:00Z"), // 3h ago
  };

  it("renders a row with marker, age, short id, project, msg count, and prompt", () => {
    const options = buildTargetOptions(
      sessionSummary,
      "abcdef1234567890",
      [{ row: heldRow, summary: sessionSummary }],
      now
    );
    // current + held + Exit
    expect(options.length).toBe(3);
    expect(options[0]).toContain("★");
    expect(options[0]).toContain("now");
    expect(options[0]).toContain("abcdef123456");
    expect(options[0]).toContain("pi-hindsight");
    expect(options[0]).toContain("12 msg");
    expect(options[0]).toContain("Implementing the gate state machine");
    expect(options[1]).toContain("3h");
    expect(options[1]).toContain("abcdef123456");
    expect(options[2]).toBe("Exit");
  });

  it("omits the current row when no currentSessionId is set", () => {
    const options = buildTargetOptions(undefined, undefined, [], now);
    expect(options).toEqual(["Exit"]);
  });
});

describe("getReviewQueueDir / getDiscardedDir", () => {
  it("default to <agentDir>/extensions/pi-hindsight/{review-queue,discarded}", () => {
    expect(getReviewQueueDir(gateConfig.retentionGate)).toBe(
      join(agentDir, "extensions", "pi-hindsight", "review-queue")
    );
    expect(getDiscardedDir(gateConfig.retentionGate)).toBe(
      join(agentDir, "extensions", "pi-hindsight", "discarded")
    );
  });

  it("respect explicit override paths", () => {
    expect(
      getReviewQueueDir({ mode: "off", reviewQueuePath: "/tmp/review", discardedPath: null })
    ).toBe("/tmp/review");
    expect(
      getDiscardedDir({ mode: "off", reviewQueuePath: null, discardedPath: "/tmp/discarded" })
    ).toBe("/tmp/discarded");
  });
});
