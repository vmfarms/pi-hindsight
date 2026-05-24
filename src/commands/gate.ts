/**
 * Retention-gate review UI (RFC §9).
 *
 * Surfaces a single `/hindsight review` subcommand that drives an interactive
 * loop over the current session and the held-session queue:
 *
 *     /hindsight review
 *       → target picker (current session + held queue + Exit)
 *         → action picker (ingest / reject / defer / flag / signal-bad / Back)
 *           → optional input + confirm
 *           → execute via {@link ../gate} transition helpers
 *           → loop back to the target picker (now with the updated queue)
 *
 * The picker uses pi-tui's {@link SelectList} so navigation, filtering, and
 * keybindings (↑↓ / j-k / Enter / Esc) match the rest of pi's TUI surface.
 * `ui.input` and `ui.confirm` from the dialog API gather reasons and gate
 * destructive transitions — same primitives as `/hindsight toggle-retain`.
 *
 * Note on history: an earlier iteration of L1 exposed `session-ingest`,
 * `session-reject`, `session-defer`, `session-flag`, `session-signal-bad` as
 * separate slash commands. They've been folded into this review flow so
 * operators have a single discoverable entry point.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";
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
 * ellipsis indicator. Full id is shown in description / confirm dialogs.
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
// Overlay component — titled SelectList
// ──────────────────────────────────────────────────────────────────────────────

const OVERLAY_OPTIONS = { anchor: "center" as const, width: 90, maxHeight: 24 };
const MAX_VISIBLE = 12;

/**
 * A SelectList wrapped with a title line and a footer hint. Used for both the
 * target picker and the action picker so they have a consistent visual frame.
 */
class TitledSelector implements Component {
  constructor(
    private title: string,
    private list: SelectList,
    private theme: Theme,
    private footer: string
  ) {}

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const inner = Math.max(20, width);
    const titleLine = this.theme.fg("accent", this.title);
    const footerLine = this.theme.fg("dim", this.footer);
    const listLines = this.list.render(inner);
    return [titleLine, "", ...listLines, "", footerLine];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Target picker (screen 1)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Result returned by the target picker. `held` carries the row chosen from the
 * review queue; `current` selects the running session; `exit` closes the loop.
 */
type TargetChoice =
  | { kind: "current"; sessionId: string }
  | { kind: "held"; row: HeldSessionRow }
  | { kind: "exit" };

const VALUE_CURRENT = "__current__";
const VALUE_EXIT = "__exit__";
const VALUE_BACK = "__back__";

/**
 * Open the target picker overlay. Lists the current session + every held row
 * (newest first) + an explicit Exit row. Returns the operator's choice.
 *
 * If `currentSessionId` is undefined (e.g. session manager isn't ready) the
 * "current session" entry is omitted — held-only flow still works.
 */
async function pickTarget(
  ctx: ExtensionContext,
  config: HindsightConfig,
  currentSessionId: string | undefined,
  heldRows: HeldSessionRow[]
): Promise<TargetChoice> {
  const items: SelectItem[] = [];
  if (currentSessionId) {
    items.push({
      value: VALUE_CURRENT,
      label: `★ Current session  ${shortenId(currentSessionId)}`,
      description: "active",
    });
  }
  for (const row of heldRows) {
    items.push({
      value: row.sessionId,
      label: `  ${shortenId(row.sessionId)}`,
      description: `held since ${formatTimestamp(row.modifiedAt)}`,
    });
  }
  items.push({ value: VALUE_EXIT, label: "Exit", description: "close /hindsight review" });

  const reviewDir = getReviewQueueDir(config.retentionGate);
  const titleSuffix = heldRows.length === 0 ? "no held sessions" : `${heldRows.length} held`;
  const title = `Hindsight review — ${titleSuffix} (${reviewDir})`;

  const choiceValue = await ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme());
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      return new TitledSelector(title, list, theme, "↑↓ navigate · Enter select · Esc exit");
    },
    { overlay: true, overlayOptions: OVERLAY_OPTIONS }
  );

  if (choiceValue === null || choiceValue === VALUE_EXIT) return { kind: "exit" };
  if (choiceValue === VALUE_CURRENT) {
    return { kind: "current", sessionId: currentSessionId ?? "" };
  }
  const row = heldRows.find((r) => r.sessionId === choiceValue);
  if (!row) return { kind: "exit" };
  return { kind: "held", row };
}

// ──────────────────────────────────────────────────────────────────────────────
// Action picker (screen 2)
// ──────────────────────────────────────────────────────────────────────────────

type Action = "ingest" | "reject" | "defer" | "flag" | "signal-bad";

interface ActionEntry {
  value: Action;
  label: string;
  description: string;
}

/**
 * Action menu — different sets for current vs held targets. Held sessions
 * can't be deferred (already deferred) or flagged (the JSONL isn't live, so
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
        description: "discard with explicit failure-mode capture",
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
      description: "discard with explicit failure-mode capture",
    },
  ];
}

/**
 * Open the action picker overlay for a chosen target. Returns the action, or
 * null when the operator cancels (Esc) — caller loops back to the target picker.
 */
async function pickAction(ctx: ExtensionContext, target: TargetChoice): Promise<Action | null> {
  const entries = actionsForTarget(target);
  const items: SelectItem[] = [
    ...entries.map<SelectItem>((e) => ({
      value: e.value,
      label: e.label,
      description: e.description,
    })),
    { value: VALUE_BACK, label: "Back", description: "choose a different session" },
  ];
  const targetLabel =
    target.kind === "current"
      ? "current session"
      : `held session ${shortenId(target.row.sessionId)}`;
  const title = `Action for ${targetLabel}`;

  const choiceValue = await ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme());
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      return new TitledSelector(title, list, theme, "↑↓ navigate · Enter select · Esc back");
    },
    { overlay: true, overlayOptions: OVERLAY_OPTIONS }
  );

  if (choiceValue === null || choiceValue === VALUE_BACK) return null;
  return choiceValue as Action;
}

// ──────────────────────────────────────────────────────────────────────────────
// Action execution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Result of an action — `cancelled` means the operator dismissed a prompt
 * mid-flow (return to picker without running the transition).
 */
interface ActionResult {
  status: "ok" | "error" | "cancelled";
  message: string;
}

/**
 * Confirm-dialog wrapper. Returns false if the operator cancels — callers
 * surface a `cancelled` status so the review loop loops back without notifying
 * an error.
 */
async function confirmAction(ctx: ExtensionContext, title: string, body: string): Promise<boolean> {
  return await ctx.ui.confirm(title, body);
}

/**
 * Prompt for an optional reason. Returns the trimmed reason (or undefined if
 * blank) — or null when the operator cancels the input dialog.
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

/**
 * Look up the canonical sessionId from a held-session symlink target — used
 * by ingest/reject paths that take a sessionPath. The symlink filename is
 * already the sessionId by our convention, so we can return the row's id;
 * this helper exists to keep callers honest about which id they're using.
 */
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
  const confirmed = await confirmAction(
    ctx,
    "Promote to Hindsight bank?",
    `Will parse and upsert ${subject} into the shared Hindsight bank. Continue?`
  );
  if (!confirmed) return { status: "cancelled", message: "Ingest cancelled" };

  if (target.kind === "current") {
    const result = await promoteSession(pi, ctx, config, client);
    return { status: result.ok ? "ok" : "error", message: result.message };
  }
  const path = targetSessionPath(target.row);
  if (!path)
    return {
      status: "error",
      message: `Held session ${target.row.sessionId} has no resolvable path`,
    };
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
  const confirmed = await confirmAction(
    ctx,
    "Discard session?",
    `Will mark ${subject} as discarded ("${reasonText}"). Queue files will be deleted and the JSONL moved to discarded/.`
  );
  if (!confirmed) return { status: "cancelled", message: "Discard cancelled" };

  if (target.kind === "current") {
    const result = await discardSession(pi, ctx, config, reasonText);
    return { status: result.ok ? "ok" : "error", message: result.message };
  }
  const path = targetSessionPath(target.row);
  if (!path)
    return {
      status: "error",
      message: `Held session ${target.row.sessionId} has no resolvable path`,
    };
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
  if (!reason)
    return { status: "error", message: "A failure-mode reason is required for signal-bad" };
  const subject =
    target.kind === "current" ? "the current session" : `held session ${target.row.sessionId}`;
  const confirmed = await confirmAction(
    ctx,
    "Signal as bad?",
    `Will discard ${subject} and tag failure mode: "${reason}". Queue files will be deleted.`
  );
  if (!confirmed) return { status: "cancelled", message: "Signal cancelled" };

  if (target.kind === "current") {
    const result = await discardSession(pi, ctx, config, reason, [reason]);
    return { status: result.ok ? "ok" : "error", message: result.message };
  }
  const path = targetSessionPath(target.row);
  if (!path)
    return {
      status: "error",
      message: `Held session ${target.row.sessionId} has no resolvable path`,
    };
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
      // Loop until the operator exits.
      while (true) {
        const reviewDir = getReviewQueueDir(config.retentionGate);
        const heldRows = listHeldSessions(reviewDir);
        const currentSessionId = ctx.sessionManager.getSessionId();

        if (!currentSessionId && heldRows.length === 0) {
          ctx.ui.notify("Nothing to review — no current session and review queue is empty", "info");
          return;
        }

        const target = await pickTarget(ctx, config, currentSessionId, heldRows);
        if (target.kind === "exit") return;

        const action = await pickAction(ctx, target);
        if (action === null) continue; // back to target picker

        const result = await executeAction(action, target, ctx, config, client, pi);
        if (result.status !== "cancelled") {
          ctx.ui.notify(result.message, result.status === "ok" ? "info" : "error");
        }
        // Loop back. The next iteration re-lists held sessions so the queue
        // reflects whatever just happened.
      }
    },
  };
}
