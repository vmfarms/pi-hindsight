/**
 * Retention-gate subcommands (RFC §9).
 *
 * Multi-action menu over the current session's gate state:
 *   - `session ingest`      → promote (parse + upsert)
 *   - `session reject`      → discard (cleanup queues, symlink for forensics)
 *   - `session flag`        → tag without changing gate state
 *   - `session defer`       → hold for later review (symlink into review-queue/)
 *   - `session signal-bad`  → discard + capture failure-mode hint
 *   - `review`              → list held sessions
 *
 * `session ingest [<path>]` and `session reject [<path>] [--reason …]` accept
 * an optional absolute path to a held-session JSONL for off-session decisions,
 * mirroring the `parse-and-upsert-session --path` pattern from iter-8.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import {
  discardSession,
  getDiscardedDir,
  getReviewQueueDir,
  holdSession,
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
    description: "Promote the current session to Hindsight (gate → promoted)",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!client) {
        ctx.ui.notify("Hindsight not configured", "error");
        return;
      }
      const { reason } = parseReasonArg(args);
      const result = await promoteSession(pi, ctx, config, client, reason);
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
    description: "Discard the current session (gate → discarded)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const { reason } = parseReasonArg(args);
      const result = await discardSession(pi, ctx, config, reason ?? "operator reject");
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
        ctx.ui.notify("Usage: /hindsight session flag <reason>", "warning");
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
        ctx.ui.notify("Usage: /hindsight session signal-bad <reason>", "warning");
        return;
      }
      const result = await discardSession(pi, ctx, config, reason, [reason]);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  };
}

/**
 * Create the `session` umbrella subcommand that dispatches to ingest/reject/
 * defer/flag/signal-bad.
 *
 * Implemented as a single subcommand with manual dispatch so it surfaces in
 * the existing `/hindsight` help block as one entry (RFC §9), and so we can
 * keep its argument completions tight.
 */
export function createSessionSubcommand(
  pi: ExtensionAPI,
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  const inner: Record<string, Subcommand> = {
    ingest: createSessionIngestSubcommand(pi, client, config),
    reject: createSessionRejectSubcommand(pi, config),
    defer: createSessionDeferSubcommand(pi, config),
    flag: createSessionFlagSubcommand(pi),
    "signal-bad": createSessionSignalBadSubcommand(pi, config),
  };
  const innerNames = Object.keys(inner);
  return {
    description: `Operator decision on the current session — actions: ${innerNames.join(", ")}`,
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(" ");
      const actionName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const actionArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
      if (!actionName) {
        ctx.ui.notify(`Usage: /hindsight session <${innerNames.join("|")}> [args]`, "warning");
        return;
      }
      const action = inner[actionName];
      if (!action) {
        ctx.ui.notify(
          `Unknown session action: ${actionName}. Available: ${innerNames.join(", ")}`,
          "error"
        );
        return;
      }
      await action.handler(actionArgs, ctx);
    },
    getArgumentCompletions: async (argumentPrefix: string) => {
      const parts = argumentPrefix.split(/\s+/);
      if (parts.length <= 1) {
        return innerNames
          .filter((n) => n.startsWith(parts[0] ?? ""))
          .map((name) => ({
            label: name,
            value: name,
            description: inner[name]?.description ?? "",
          }));
      }
      return null;
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
