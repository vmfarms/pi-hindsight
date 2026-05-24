/**
 * Retention-gate state transitions.
 *
 * The gate is a state machine attached to each session via hindsight-meta entries.
 * Transitions are write-only — every change appends a new GateDecision, so the
 * session JSONL preserves the full decision history. Read state via
 * {@link getGateDecision}.
 *
 * Three operator-initiated transitions are supported:
 *   - {@link holdSession}     — defer for later review (symlinked into review-queue/)
 *   - {@link discardSession}  — reject and clean up queue files
 *   - {@link promoteSession}  — ingest into Hindsight via parse-and-upsert
 *
 * The flush chokepoint in src/index.ts only proceeds when the latest gate
 * status is "promoted"; all other statuses (pending / held / discarded) no-op.
 */

import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "./client";
import { parseAndUpsertSession } from "./commands/utils";
import type { HindsightConfig, RetentionGateConfig } from "./config";
import { type GateDecision, getGateDecision, getHindsightMeta, setGateDecision } from "./meta";
import { deleteQueuesForSession } from "./queue";

/** Default subdirectories under <agentDir>/extensions/pi-hindsight/ for held/discarded symlinks. */
const REVIEW_QUEUE_SUBDIR = ["extensions", "pi-hindsight", "review-queue"] as const;
const DISCARDED_SUBDIR = ["extensions", "pi-hindsight", "discarded"] as const;

/**
 * Resolve the directory where held-session symlinks live.
 * Honors config.retentionGate.reviewQueuePath; falls back to <agentDir>/extensions/pi-hindsight/review-queue/.
 */
export function getReviewQueueDir(gate: RetentionGateConfig): string {
  return gate.reviewQueuePath ?? join(getAgentDir(), ...REVIEW_QUEUE_SUBDIR);
}

/**
 * Resolve the directory where discarded-session symlinks live.
 * Honors config.retentionGate.discardedPath; falls back to <agentDir>/extensions/pi-hindsight/discarded/.
 */
export function getDiscardedDir(gate: RetentionGateConfig): string {
  return gate.discardedPath ?? join(getAgentDir(), ...DISCARDED_SUBDIR);
}

/**
 * Create a symlink at `linkPath` → `targetPath`, replacing any existing entry
 * at `linkPath`. Best-effort: errors are logged and surfaced via the return
 * value so callers can decide whether to notify the operator.
 */
function placeSymlink(targetPath: string, linkPath: string): { ok: boolean; error?: string } {
  try {
    const linkDir = dirname(linkPath);
    if (!existsSync(linkDir)) {
      mkdirSync(linkDir, { recursive: true });
    }
    // Replace an existing symlink/file at linkPath if present, so re-running
    // the transition is idempotent.
    if (existsSync(linkPath)) {
      try {
        unlinkSync(linkPath);
      } catch {
        // ignore — symlinkSync will surface the real error
      }
    }
    symlinkSync(targetPath, linkPath);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * Find the JSONL path for the current session. Returns undefined if the
 * session has not yet been persisted to disk (rare — typically only true at
 * the very start of a brand-new session).
 */
function getSessionFilePath(ctx: ExtensionContext): string | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return sessionFile ?? undefined;
}

/**
 * Append a new gate decision to the session, preserving prior retained/tags
 * fields by reading the latest hindsight-meta entry first.
 */
function appendGateDecision(pi: ExtensionAPI, ctx: ExtensionContext, gate: GateDecision): void {
  const entries = ctx.sessionManager.getEntries();
  const existingMeta = getHindsightMeta(entries);
  pi.appendEntry("hindsight-meta", setGateDecision(gate, existingMeta));
}

/**
 * Result of a gate transition. `linkPath` is set when a symlink was created.
 */
export interface GateTransitionResult {
  ok: boolean;
  message: string;
  linkPath?: string;
  error?: string;
}

/**
 * Defer the current session for later review.
 *
 * Appends a `gate.status = "held"` decision and symlinks the session JSONL
 * into the review-queue directory so operators can find it later via
 * `/hindsight review`.
 */
export async function holdSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: HindsightConfig,
  reason?: string,
  decidedBy: GateDecision["decidedBy"] = "operator"
): Promise<GateTransitionResult> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return { ok: false, message: "No active session" };
  }

  appendGateDecision(pi, ctx, {
    status: "held",
    decidedAt: new Date().toISOString(),
    decidedBy,
    reason,
  });

  const sessionFile = getSessionFilePath(ctx);
  if (!sessionFile) {
    return {
      ok: true,
      message: "Session marked as held (no on-disk JSONL yet — symlink skipped)",
    };
  }

  const linkPath = join(getReviewQueueDir(config.retentionGate), `${sessionId}.jsonl`);
  const link = placeSymlink(sessionFile, linkPath);
  if (!link.ok) {
    return {
      ok: false,
      message: `Session marked as held, but symlink creation failed: ${link.error}`,
      error: link.error,
    };
  }
  return { ok: true, message: "Session held for review", linkPath };
}

/**
 * Reject the current session.
 *
 * Appends a `gate.status = "discarded"` decision, symlinks the session JSONL
 * into the discarded directory for forensic review, and removes any queue
 * files so nothing leaks to Hindsight on a later flush.
 */
export async function discardSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: HindsightConfig,
  reason: string,
  failureModes?: string[],
  decidedBy: GateDecision["decidedBy"] = "operator"
): Promise<GateTransitionResult> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return { ok: false, message: "No active session" };
  }

  appendGateDecision(pi, ctx, {
    status: "discarded",
    decidedAt: new Date().toISOString(),
    decidedBy,
    reason,
    failureModes,
  });

  deleteQueuesForSession(sessionId);

  const sessionFile = getSessionFilePath(ctx);
  if (!sessionFile) {
    return {
      ok: true,
      message: "Session marked as discarded (no on-disk JSONL yet — symlink skipped)",
    };
  }

  const linkPath = join(getDiscardedDir(config.retentionGate), `${sessionId}.jsonl`);
  const link = placeSymlink(sessionFile, linkPath);
  if (!link.ok) {
    return {
      ok: false,
      message: `Session marked as discarded, but symlink creation failed: ${link.error}`,
      error: link.error,
    };
  }
  return { ok: true, message: "Session discarded", linkPath };
}

/**
 * Promote the current session into Hindsight.
 *
 * Appends a `gate.status = "promoted"` decision, then runs the full
 * parse-and-upsert flow on the running session. On success, queue files are
 * cleaned up (parseAndUpsertSession deletes the auto-queue; we also drop the
 * tool-queue defensively).
 *
 * The flush chokepoint in src/index.ts reads the latest gate decision before
 * flushing — once promoted, subsequent `flushCurrentSession()` calls proceed
 * normally.
 */
export async function promoteSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  reason?: string,
  decidedBy: GateDecision["decidedBy"] = "operator"
): Promise<GateTransitionResult> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return { ok: false, message: "No active session" };
  }

  appendGateDecision(pi, ctx, {
    status: "promoted",
    decidedAt: new Date().toISOString(),
    decidedBy,
    reason,
  });

  try {
    const result = await parseAndUpsertSession(ctx, config, client);
    // parseAndUpsertSession deletes the auto-queue on success but leaves the
    // tool-queue (tool retains are separate documents). Once a session is
    // promoted-and-ingested, clean both so the chokepoint flush — which would
    // otherwise re-flush the tool-queue on shutdown — has nothing to send.
    deleteQueuesForSession(sessionId);
    return {
      ok: result.level === "info",
      message: result.message,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `Promotion failed during upsert: ${message}`,
      error: message,
    };
  }
}

/**
 * Re-export commonly needed read helper for callers wiring up gate-aware UI.
 */
export { getGateDecision };
