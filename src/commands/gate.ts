/**
 * Retention-gate review UI (RFC §9).
 *
 * Surfaces a single `/hindsight review` subcommand that drives an interactive
 * loop over the current session and the held-session queue using pi's
 * inline dialog primitives (`ui.select` / `ui.confirm` / `ui.input`) — the
 * same style as `/hindsight toggle-retain` and the rest of the pi UX.
 *
 *     /hindsight review
 *       → ui.select: pick target (current session + held queue + Exit)
 *         → ui.select: pick action (ingest / reject / defer / flag / signal-bad / Back)
 *           → ui.input for an optional reason (when applicable)
 *           → ui.confirm for destructive ops (ingest / reject / signal-bad)
 *           → execute via {@link ../gate} transition helpers
 *           → loop back to the target picker (queue re-listed fresh)
 *
 * Note on history: an earlier iteration of L1 exposed `session-ingest`,
 * `session-reject`, `session-defer`, `session-flag`, `session-signal-bad` as
 * separate slash commands. They've been folded into this review flow so
 * operators have a single discoverable entry point.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import type { HindsightConfig } from "../config";
import {
  discardHeldSession,
  discardSession,
  getReviewQueueDir,
  holdSession,
  promoteHeldSession,
  promoteSession,
} from "../gate";
import { getHindsightMeta } from "../meta";
import type { Subcommand } from "./types";

// ──────────────────────────────────────────────────────────────────────────────
// Held-queue listing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * One row from the review-queue directory. Returned by {@link listHeldSessions}
 * for both UI rendering and unit tests.
 */
export interface HeldSessionRow {
  sessionId: string;
  linkPath: string;
  /** Symlink target resolved to an absolute path; undefined when unresolvable. */
  targetPath: string | undefined;
  /** mtime of the resolved target (or symlink if target is gone). */
  modifiedAt: Date | undefined;
}

/**
 * Enumerate held sessions by reading symlinks from the review-queue directory.
 * Returned newest-first; entries with unreadable targets still appear so
 * operators can clean up stale links.
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
        targetPath = linkPath;
      }
    } catch {
      // ignore
    }
    let modifiedAt: Date | undefined;
    if (targetPath) {
      try {
        modifiedAt = statSync(targetPath).mtime;
      } catch {
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
 * Short id used in picker labels — first 12 chars of the sessionId plus an
 * ellipsis indicator. Full id is shown in confirm dialogs.
 */
function shortenId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

/**
 * Format a human-readable timestamp ("2026-05-24 10:00") from a Date, with a
 * "?" fallback for entries whose mtime couldn't be resolved.
 */
function formatTimestamp(when: Date | undefined): string {
  if (!when) return "?";
  return when.toISOString().slice(0, 16).replace("T", " ");
}

// ──────────────────────────────────────────────────────────────────────────────
// Target picker
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Result returned by the target picker. `held` carries the row chosen from the
 * review queue; `current` selects the running session; `exit` closes the loop.
 */
type TargetChoice =
  | { kind: "current"; sessionId: string }
  | { kind: "held"; row: HeldSessionRow }
  | { kind: "exit" };

// Sentinel-prefixed option labels — string parsing handles dispatch since
// ui.select only knows about plain strings.
const CURRENT_PREFIX = "★ Current session — ";
const HELD_PREFIX = "  ";
const EXIT_OPTION = "Exit";
const BACK_OPTION = "← Back";

/**
 * Build the target-picker option strings. Exported for tests so we can verify
 * the formatting matches the parser without booting the UI.
 */
export function buildTargetOptions(
  currentSessionId: string | undefined,
  heldRows: HeldSessionRow[]
): string[] {
  const options: string[] = [];
  if (currentSessionId) {
    options.push(`${CURRENT_PREFIX}${shortenId(currentSessionId)}`);
  }
  for (const row of heldRows) {
    const ts = formatTimestamp(row.modifiedAt);
    options.push(`${HELD_PREFIX}${ts}  ${shortenId(row.sessionId)}  (held)`);
  }
  options.push(EXIT_OPTION);
  return options;
}

/**
 * Parse a target-picker selection back into a {@link TargetChoice}. Returns
 * "exit" for the explicit exit row, an undefined/cancel result, or any label
 * that doesn't match a known pattern. Falls back to the held-row sessionId
 * for matching to avoid coupling to the exact formatting of the label.
 */
function parseTargetChoice(
  choice: string | undefined,
  currentSessionId: string | undefined,
  heldRows: HeldSessionRow[]
): TargetChoice {
  if (!choice || choice === EXIT_OPTION) return { kind: "exit" };
  if (currentSessionId && choice.startsWith(CURRENT_PREFIX)) {
    return { kind: "current", sessionId: currentSessionId };
  }
  // Held rows: match by short id suffix to be robust against label tweaks.
  for (const row of heldRows) {
    if (choice.includes(shortenId(row.sessionId))) {
      return { kind: "held", row };
    }
  }
  return { kind: "exit" };
}

// ──────────────────────────────────────────────────────────────────────────────
// Action picker
// ──────────────────────────────────────────────────────────────────────────────

type Action = "ingest" | "reject" | "defer" | "flag" | "signal-bad";

interface ActionEntry {
  value: Action;
  label: string;
  description: string;
}

/**
 * Action menu — different sets for current vs held targets. Held sessions
 * can't be deferred (already deferred) or flagged (their JSONL isn't live so
 * an appendEntry tag wouldn't be coherent).
 */
function actionsForTarget(target: TargetChoice): ActionEntry[] {
  if (target.kind === "held") {
    return [
      { value: "ingest", label: "Ingest", description: "promote to Hindsight bank" },
      { value: "reject", label: "Reject", description: "discard (move to discarded/)" },
      {
        value: "signal-bad",
        label: "Signal as bad",
        description: "discard with failure-mode capture",
      },
    ];
  }
  return [
    { value: "ingest", label: "Ingest", description: "promote to Hindsight bank" },
    { value: "reject", label: "Reject", description: "discard the current session" },
    { value: "defer", label: "Defer", description: "hold for later review" },
    { value: "flag", label: "Flag", description: "annotate without changing gate state" },
    {
      value: "signal-bad",
      label: "Signal as bad",
      description: "discard with failure-mode capture",
    },
  ];
}

/**
 * Render an action entry as a select option label. Format keeps the label as
 * the leading prefix so {@link parseActionChoice} can match on it.
 */
function formatActionOption(entry: ActionEntry): string {
  return `${entry.label} — ${entry.description}`;
}

/**
 * Parse an action selection back into an {@link Action}. Returns null when
 * the operator cancels (Esc) or picks Back.
 */
function parseActionChoice(choice: string | undefined, entries: ActionEntry[]): Action | null {
  if (!choice || choice === BACK_OPTION) return null;
  for (const entry of entries) {
    if (choice.startsWith(entry.label)) return entry.value;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Action execution
// ──────────────────────────────────────────────────────────────────────────────

interface ActionResult {
  status: "ok" | "error" | "cancelled";
  message: string;
}

/**
 * Prompt for an optional reason via ui.input. Returns:
 *   - null if the operator cancels (Esc)
 *   - undefined if the operator submits an empty string
 *   - the trimmed reason otherwise
 */
async function promptReason(
  ctx: ExtensionContext,
  title: string,
  placeholder: string
): Promise<string | undefined | null> {
  const input = await ctx.ui.input(title, placeholder);
  if (input === undefined) return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function targetSessionPath(row: HeldSessionRow): string | undefined {
  return row.targetPath;
}

async function executeIngest(
  ctx: ExtensionContext,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
  pi: ExtensionAPI,
  target: TargetChoice
): Promise<ActionResult> {
  if (!client) return { status: "error", message: "Hindsight not configured" };
  const subject =
    target.kind === "current" ? "the current session" : `held session ${target.row.sessionId}`;
  const confirmed = await ctx.ui.confirm(
    "Promote to Hindsight bank?",
    `Will parse and upsert ${subject} into the shared Hindsight bank. Continue?`
  );
  if (!confirmed) return { status: "cancelled", message: "Ingest cancelled" };

  if (target.kind === "current") {
    const result = await promoteSession(pi, ctx, config, client);
    return { status: result.ok ? "ok" : "error", message: result.message };
  }
  const path = targetSessionPath(target.row);
  if (!path) {
    return {
      status: "error",
      message: `Held session ${target.row.sessionId} has no resolvable path`,
    };
  }
  const result = await promoteHeldSession(ctx, config, client, target.row.sessionId, path);
  return { status: result.ok ? "ok" : "error", message: result.message };
}

async function executeReject(
  ctx: ExtensionContext,
  config: HindsightConfig,
  pi: ExtensionAPI,
  target: TargetChoice
): Promise<ActionResult> {
  const reason = await promptReason(
    ctx,
    "Discard reason (optional)",
    "e.g. low quality, off-topic"
  );
  if (reason === null) return { status: "cancelled", message: "Discard cancelled" };
  const reasonText = reason ?? "operator reject";
  const subject =
    target.kind === "current" ? "the current session" : `held session ${target.row.sessionId}`;
  const confirmed = await ctx.ui.confirm(
    "Discard session?",
    `Will mark ${subject} as discarded ("${reasonText}"). Queue files will be deleted and the JSONL moved to discarded/.`
  );
  if (!confirmed) return { status: "cancelled", message: "Discard cancelled" };

  if (target.kind === "current") {
    const result = await discardSession(pi, ctx, config, reasonText);
    return { status: result.ok ? "ok" : "error", message: result.message };
  }
  const path = targetSessionPath(target.row);
  if (!path) {
    return {
      status: "error",
      message: `Held session ${target.row.sessionId} has no resolvable path`,
    };
  }
  const result = discardHeldSession(config, target.row.sessionId, path, reasonText);
  return { status: result.ok ? "ok" : "error", message: result.message };
}

async function executeDefer(
  ctx: ExtensionContext,
  config: HindsightConfig,
  pi: ExtensionAPI,
  target: TargetChoice
): Promise<ActionResult> {
  if (target.kind !== "current") {
    return { status: "error", message: "Defer is only available for the current session" };
  }
  const reason = await promptReason(ctx, "Defer reason (optional)", "e.g. needs second look");
  if (reason === null) return { status: "cancelled", message: "Defer cancelled" };
  const result = await holdSession(pi, ctx, config, reason);
  return { status: result.ok ? "ok" : "error", message: result.message };
}

async function executeFlag(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  target: TargetChoice
): Promise<ActionResult> {
  if (target.kind !== "current") {
    return { status: "error", message: "Flag is only available for the current session" };
  }
  const reason = await promptReason(ctx, "Flag reason", "e.g. revisit, needs-judge");
  if (reason === null) return { status: "cancelled", message: "Flag cancelled" };
  if (!reason) return { status: "error", message: "Flag reason cannot be empty" };
  const entries = ctx.sessionManager.getEntries();
  const existingMeta = getHindsightMeta(entries);
  const tag = `flag:${reason}`;
  const existingTags = existingMeta?.tags ?? [];
  if (existingTags.includes(tag)) {
    return { status: "error", message: `Flag "${reason}" already set` };
  }
  const next = {
    ...(existingMeta?.retained !== undefined ? { retained: existingMeta.retained } : {}),
    ...(existingMeta?.gate ? { gate: existingMeta.gate } : {}),
    tags: [...existingTags, tag],
  };
  pi.appendEntry("hindsight-meta", next);
  return { status: "ok", message: `Session flagged: ${reason}` };
}

async function executeSignalBad(
  ctx: ExtensionContext,
  config: HindsightConfig,
  pi: ExtensionAPI,
  target: TargetChoice
): Promise<ActionResult> {
  const reason = await promptReason(
    ctx,
    "Failure mode (required)",
    "e.g. hallucinated-tool, off-topic"
  );
  if (reason === null) return { status: "cancelled", message: "Signal cancelled" };
  if (!reason) {
    return { status: "error", message: "A failure-mode reason is required for signal-bad" };
  }
  const subject =
    target.kind === "current" ? "the current session" : `held session ${target.row.sessionId}`;
  const confirmed = await ctx.ui.confirm(
    "Signal as bad?",
    `Will discard ${subject} and tag failure mode: "${reason}". Queue files will be deleted.`
  );
  if (!confirmed) return { status: "cancelled", message: "Signal cancelled" };

  if (target.kind === "current") {
    const result = await discardSession(pi, ctx, config, reason, [reason]);
    return { status: result.ok ? "ok" : "error", message: result.message };
  }
  const path = targetSessionPath(target.row);
  if (!path) {
    return {
      status: "error",
      message: `Held session ${target.row.sessionId} has no resolvable path`,
    };
  }
  const result = discardHeldSession(config, target.row.sessionId, path, reason);
  return { status: result.ok ? "ok" : "error", message: result.message };
}

async function executeAction(
  action: Action,
  target: TargetChoice,
  ctx: ExtensionContext,
  config: HindsightConfig,
  client: HindsightClientWrapper | null,
  pi: ExtensionAPI
): Promise<ActionResult> {
  switch (action) {
    case "ingest":
      return executeIngest(ctx, config, client, pi, target);
    case "reject":
      return executeReject(ctx, config, pi, target);
    case "defer":
      return executeDefer(ctx, config, pi, target);
    case "flag":
      return executeFlag(ctx, pi, target);
    case "signal-bad":
      return executeSignalBad(ctx, config, pi, target);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Review subcommand — the single operator entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create the `/hindsight review` subcommand.
 *
 * Runs an interactive loop: pick a target session, pick an action, gather any
 * reason input, confirm if destructive, execute via the gate transition
 * helpers, then re-list the queue and prompt again. Exiting from the target
 * picker (Esc or "Exit" row) closes the loop.
 */
export function createReviewSubcommand(
  pi: ExtensionAPI,
  client: HindsightClientWrapper | null,
  config: HindsightConfig
): Subcommand {
  return {
    description:
      "Review held sessions and the current session, then ingest / reject / defer / flag",
    handler: async (_args: string, ctx: ExtensionContext) => {
      while (true) {
        const reviewDir = getReviewQueueDir(config.retentionGate);
        const heldRows = listHeldSessions(reviewDir);
        const currentSessionId = ctx.sessionManager.getSessionId();

        if (!currentSessionId && heldRows.length === 0) {
          ctx.ui.notify("Nothing to review — no current session and review queue is empty", "info");
          return;
        }

        const options = buildTargetOptions(currentSessionId, heldRows);
        const heldCount = heldRows.length;
        const heldDescriptor = heldCount === 0 ? "no held sessions" : `${heldCount} held`;
        const targetTitle = `Hindsight review — ${heldDescriptor}`;
        const targetChoiceLabel = await ctx.ui.select(targetTitle, options);
        const target = parseTargetChoice(targetChoiceLabel, currentSessionId, heldRows);
        if (target.kind === "exit") return;

        const actionEntries = actionsForTarget(target);
        const actionOptions = [...actionEntries.map(formatActionOption), BACK_OPTION];
        const actionTitle =
          target.kind === "current"
            ? "Action for current session"
            : `Action for held session ${shortenId(target.row.sessionId)}`;
        const actionChoiceLabel = await ctx.ui.select(actionTitle, actionOptions);
        const action = parseActionChoice(actionChoiceLabel, actionEntries);
        if (action === null) continue; // back to target picker

        const result = await executeAction(action, target, ctx, config, client, pi);
        if (result.status !== "cancelled") {
          ctx.ui.notify(result.message, result.status === "ok" ? "info" : "error");
        }
        // Loop: re-list held sessions to reflect whatever just happened.
      }
    },
  };
}
