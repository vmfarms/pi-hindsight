/**
 * Retention-gate subcommands (RFC §9).
 *
 * Flat multi-action menu over the current session's gate state — pi's
 * slash-command dispatcher is single-token, so each gate verb is its own
 * top-level subcommand (hyphenated). The handoff used `session ingest` etc.
 * as a logical grouping; on the wire those become `session-ingest`, etc.
 *
 *   - `session-ingest`      → promote (parse + upsert)
 *   - `session-reject`      → discard (cleanup queues, symlink for forensics)
 *   - `session-flag`        → tag without changing gate state
 *   - `session-defer`       → hold for later review (symlink into review-queue/)
 *   - `session-signal-bad`  → discard + capture failure-mode hint
 *   - `review`              → list held sessions
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import { parseSessionFile } from "../document";
import {
  discardHeldSession,
  discardSession,
  getDiscardedDir,
  getReviewQueueDir,
  holdSession,
  promoteHeldSession,
  promoteSession,
} from "../gate";
import { getHindsightMeta } from "../meta";
import type { Subcommand } from "./types";

/**
 * Extract a reason from `--reason "<text>"` or `--reason <bareword>` style args.
 * Returns the trimmed reason and the remainder of args (anything before --reason).
 */
function parseReasonArg(args: string): { reason?: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { rest: "" };
  const reasonIdx = trimmed.indexOf("--reason");
  if (reasonIdx === -1) return { rest: trimmed };
  const before = trimmed.slice(0, reasonIdx).trim();
  let after = trimmed.slice(reasonIdx + "--reason".length).trim();
  if (!after) return { rest: before };
  // Support quoted reasons "..." or '...'
  if (
    (after.startsWith('"') && after.endsWith('"')) ||
    (after.startsWith("'") && after.endsWith("'"))
  ) {
    after = after.slice(1, -1);
  }
  return { reason: after, rest: before };
}

/**
 * Result of {@link resolveHeldTarget} — either a usable target or an
 * operator-facing error string.
 */
export type HeldTargetResolution =
  | { kind: "current" }
  | { kind: "target"; sessionId: string; sessionPath: string }
  | { kind: "error"; error: string };

/**
 * Interpret the leading positional arg on `session-ingest` / `session-reject`:
 *
 *   - empty           → act on current session
 *   - positive int N  → row N from `/hindsight review` (1-indexed)
 *   - absolute path   → that JSONL file (off-session)
 *
 * Reads the JSONL header to recover the canonical sessionId (the symlink
 * filename is convention-based; the header is the source of truth).
 */
export function resolveHeldTarget(reviewDir: string, positionalArg: string): HeldTargetResolution {
  const arg = positionalArg.trim();
  if (!arg) return { kind: "current" };

  // Numeric row argument: look up row N (1-indexed) in the current listing.
  if (/^\d+$/.test(arg)) {
    const row = Number.parseInt(arg, 10);
    if (row < 1) return { kind: "error", error: `Row index must be ≥ 1 (got ${arg})` };
    const rows = listHeldSessions(reviewDir);
    if (row > rows.length) {
      return {
        kind: "error",
        error: `Row ${row} out of range — only ${rows.length} held session(s). Run /hindsight review to see the list.`,
      };
    }
    const target = rows[row - 1];
    if (!target?.targetPath) {
      return {
        kind: "error",
        error: `Row ${row} has no resolvable target (dangling symlink?)`,
      };
    }
    return resolveJsonlPath(target.targetPath);
  }

  // Absolute path: take as a direct file reference.
  if (isAbsolute(arg)) {
    return resolveJsonlPath(arg);
  }

  return {
    kind: "error",
    error: `Unrecognized argument: ${arg}. Pass a row number from /hindsight review, or an absolute path to a session JSONL.`,
  };
}

/**
 * Read the session JSONL header to recover its canonical sessionId, returning
 * a `target` resolution or an `error` if the file is unusable. Shared between
 * row-based and path-based forms of {@link resolveHeldTarget}.
 */
function resolveJsonlPath(sessionPath: string): HeldTargetResolution {
  if (!existsSync(sessionPath)) {
    return { kind: "error", error: `Session file not found: ${sessionPath}` };
  }
  try {
    const { header } = parseSessionFile(sessionPath);
    if (!header?.id) {
      return { kind: "error", error: `No session id in header for ${sessionPath}` };
    }
    return { kind: "target", sessionId: header.id, sessionPath };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "error", error: `Failed to parse ${sessionPath}: ${message}` };
  }
}

/**
 * Create `session ingest` — promote the current session.
 *
 * Sets gate.status = "promoted" and runs parse-and-upsert via gate helpers.
 * Operators run this when a session is worth keeping in Hindsight.
 */
export function createSessionIngestSubcommand(
  pi: ExtensionAPI,
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description:
      "Promote a session to Hindsight (current by default, or by row from /hindsight review, or by --path <abs>)",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }
      const { reason, rest } = parseReasonArg(args);
      const target = resolveHeldTarget(getReviewQueueDir(config.retentionGate), rest);

      if (target.kind === "error") {
        ctx.ui.notify(target.error, "error");
        return;
      }
      if (target.kind === "current") {
        const result = await promoteSession(pi, ctx, config, client, reason);
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
        return;
      }
      const result = await promoteHeldSession(
        ctx,
        config,
        client,
        target.sessionId,
        target.sessionPath
      );
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  };
}

/**
 * Create `session reject` — discard the current session.
 *
 * Sets gate.status = "discarded", removes queue files, symlinks the source
 * JSONL into discarded/ for forensic review.
 */
export function createSessionRejectSubcommand(
  pi: ExtensionAPI,
  config: HindsightConfig
): Subcommand {
  return {
    description:
      "Discard a session (current by default, or by row from /hindsight review, or by --path <abs>)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const { reason, rest } = parseReasonArg(args);
      const target = resolveHeldTarget(getReviewQueueDir(config.retentionGate), rest);
      const reasonOrDefault = reason ?? "operator reject";

      if (target.kind === "error") {
        ctx.ui.notify(target.error, "error");
        return;
      }
      if (target.kind === "current") {
        const result = await discardSession(pi, ctx, config, reasonOrDefault);
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
        return;
      }
      const result = discardHeldSession(
        config,
        target.sessionId,
        target.sessionPath,
        reasonOrDefault
      );
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  };
}

/**
 * Create `session defer` — hold the current session for later review.
 *
 * Sets gate.status = "held" and symlinks the source JSONL into review-queue/.
 * Operators use this when they want a second look later (or want the worker
 * to pick it up in autonomous-defer mode).
 */
export function createSessionDeferSubcommand(
  pi: ExtensionAPI,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Defer the current session for later review (gate → held)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const reason = args.trim() || undefined;
      const result = await holdSession(pi, ctx, config, reason);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  };
}

/**
 * Create `session flag <tag>` — annotate without changing gate state.
 *
 * Appends a flag-prefixed tag to session metadata so operators can mark
 * sessions for follow-up without committing to ingest/discard.
 */
export function createSessionFlagSubcommand(pi: ExtensionAPI): Subcommand {
  return {
    description: "Flag the current session with a reason (no gate transition)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const reason = args.trim();
      if (!reason) {
        ctx.ui.notify("Usage: /hindsight session-flag <reason>", "warning");
        return;
      }
      const entries = ctx.sessionManager.getEntries();
      const existingMeta = getHindsightMeta(entries);
      const tag = `flag:${reason}`;
      const existingTags = existingMeta?.tags ?? [];
      if (existingTags.includes(tag)) {
        ctx.ui.notify(`Flag "${reason}" already set`, "warning");
        return;
      }
      const next = {
        ...(existingMeta?.retained !== undefined ? { retained: existingMeta.retained } : {}),
        ...(existingMeta?.gate ? { gate: existingMeta.gate } : {}),
        tags: [...existingTags, tag],
      };
      pi.appendEntry("hindsight-meta", next);
      ctx.ui.notify(`Session flagged: ${reason}`, "info");
    },
  };
}

/**
 * Create `session signal-bad <reason>` — discard with explicit failure-mode capture.
 *
 * Convenience over `session reject` that also captures the reason as a failure
 * mode in the gate decision, surfacing it to downstream worker/judge agents.
 */
export function createSessionSignalBadSubcommand(
  pi: ExtensionAPI,
  config: HindsightConfig
): Subcommand {
  return {
    description: "Discard the current session as bad-behavior signal (gate → discarded)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const reason = args.trim();
      if (!reason) {
        ctx.ui.notify("Usage: /hindsight session-signal-bad <reason>", "warning");
        return;
      }
      const result = await discardSession(pi, ctx, config, reason, [reason]);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  };
}

/**
 * Listing entry returned by {@link listHeldSessions} — used by both the
 * `review` subcommand UI and unit tests for the review-queue helper.
 */
export interface HeldSessionRow {
  sessionId: string;
  linkPath: string;
  /** Resolved target of the symlink (the actual session JSONL on disk). */
  targetPath: string | undefined;
  /** mtime of the target JSONL if accessible; falls back to the symlink mtime. */
  modifiedAt: Date | undefined;
}

/**
 * Enumerate held sessions by reading symlinks from the review-queue directory.
 * Returns sorted-newest-first; entries with unreadable targets still appear so
 * operators can clean up stale symlinks.
 */
export function listHeldSessions(reviewDir: string): HeldSessionRow[] {
  if (!existsSync(reviewDir)) return [];
  const entries: HeldSessionRow[] = [];
  for (const name of readdirSync(reviewDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const linkPath = join(reviewDir, name);
    const sessionId = name.replace(/\.jsonl$/, "");
    let targetPath: string | undefined;
    try {
      const lst = lstatSync(linkPath);
      if (lst.isSymbolicLink()) {
        targetPath = readlinkSync(linkPath);
      } else {
        // Plain file (not a symlink) — still surface it.
        targetPath = linkPath;
      }
    } catch {
      // ignore — entry has no readable metadata
    }
    let modifiedAt: Date | undefined;
    if (targetPath) {
      try {
        const stat = statSync(targetPath);
        modifiedAt = stat.mtime;
      } catch {
        // target gone — fall back to symlink mtime
        try {
          modifiedAt = lstatSync(linkPath).mtime;
        } catch {
          // ignore
        }
      }
    }
    entries.push({ sessionId, linkPath, targetPath, modifiedAt });
  }
  entries.sort((a, b) => {
    const ta = a.modifiedAt?.getTime() ?? 0;
    const tb = b.modifiedAt?.getTime() ?? 0;
    return tb - ta;
  });
  return entries;
}

/**
 * Create the `review` subcommand — list held sessions.
 *
 * Output is human-readable for interactive use: row number, modified-at,
 * sessionId, and target path. The L4 worker uses the same review-queue
 * directory but enumerates from JSONL targets directly.
 */
export function createReviewSubcommand(config: HindsightConfig): Subcommand {
  return {
    description: "List held sessions awaiting review",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const reviewDir = getReviewQueueDir(config.retentionGate);
      const rows = listHeldSessions(reviewDir);
      if (rows.length === 0) {
        ctx.ui.notify(`Review queue empty (${reviewDir})`, "info");
        return;
      }
      const lines = rows.map((row, i) => {
        const idx = String(i + 1).padStart(2, " ");
        const when = row.modifiedAt ? row.modifiedAt.toISOString() : "?";
        const target = row.targetPath ?? "(unresolved)";
        return `${idx}. ${when}  ${row.sessionId}  → ${target}`;
      });
      ctx.ui.notify(`Held sessions (${rows.length}):\n${lines.join("\n")}`, "info");
    },
  };
}

/**
 * Export reference to discarded-dir helper for tests / future commands.
 */
export { getDiscardedDir };
