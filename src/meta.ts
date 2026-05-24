/**
 * Hindsight session metadata management.
 *
 * Session metadata (retention state, tags) is stored as CustomEntry
 * entries in the session file with customType "hindsight-meta".
 * Since session files are append-only, each operation appends a new entry,
 * and the latest one is the current state.
 */

import type { HindsightConfig } from "./config";

/**
 * Retention-gate decision attached to a session.
 *
 * Status transitions:
 *   pending (initial, set at session_start)
 *     → promoted  (operator/worker decided to ingest → flush proceeds)
 *     → held      (deferred — symlinked into review-queue/, waiting on a later decision)
 *     → discarded (rejected — symlinked into discarded/, queue files removed)
 *
 * Only `promoted` allows flushCurrentSession() to call into Hindsight.
 * All other statuses no-op the flush chokepoint.
 */
export interface GateDecision {
  status: "pending" | "promoted" | "discarded" | "held";
  decidedAt: string;
  decidedBy: "operator" | "worker" | "auto";
  reason?: string;
  evaluator?: string;
  score?: number;
  failureModes?: string[];
}

/**
 * Session metadata stored in CustomEntry with customType "hindsight-meta".
 * All fields are optional — only the fields that have been set are present.
 */
export interface HindsightMeta {
  retained?: boolean;
  tags?: string[];
  gate?: GateDecision;
}

/**
 * Get the latest hindsight metadata from session entries.
 * Scans from newest to oldest for the most recent "hindsight-meta" CustomEntry.
 * Returns null if no metadata entry exists.
 */
export function getHindsightMeta(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): HindsightMeta | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "custom" &&
      entry.customType === "hindsight-meta" &&
      entry.data !== undefined
    ) {
      return entry.data as HindsightMeta;
    }
  }
  return null;
}

/**
 * Determine whether a session should be retained.
 * Checks the latest hindsight-meta entry for a retained field.
 * If no metadata entry exists or retained is undefined, falls back
 * to the retainSessionsByDefault config value.
 *
 * Note: The session_start handler auto-creates metadata with
 * retained=retainSessionsByDefault when no metadata exists, so this
 * fallback is only relevant before session_start fires or if
 * metadata somehow gets into an inconsistent state.
 */
export function shouldSessionBeRetained(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  config: Pick<HindsightConfig, "retainSessionsByDefault">
): boolean {
  const meta = getHindsightMeta(entries);
  if (meta?.retained !== undefined) {
    return meta.retained;
  }
  return config.retainSessionsByDefault;
}

/**
 * Find the latest gate decision in session entries.
 *
 * Scans hindsight-meta entries from newest to oldest and returns the first one
 * whose `gate` field is set. This is independent of {@link getHindsightMeta},
 * which always returns only the most recent entry — gate state has its own
 * latest-wins semantic so that later metadata writes (e.g. tag additions) don't
 * clobber a previously-recorded gate decision.
 *
 * Returns undefined if no entry has set a gate decision.
 */
export function getGateDecision(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): GateDecision | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "custom" &&
      entry.customType === "hindsight-meta" &&
      entry.data !== undefined
    ) {
      const data = entry.data as HindsightMeta;
      if (data.gate !== undefined) {
        return data.gate;
      }
    }
  }
  return undefined;
}

/**
 * Build a HindsightMeta payload that sets the given gate decision, carrying
 * forward existing `retained` and `tags` fields from the prior meta entry so
 * those values aren't lost when this new entry is appended.
 *
 * Use with pi.appendEntry("hindsight-meta", setGateDecision(gate, existingMeta)).
 */
export function setGateDecision(
  gate: GateDecision,
  existing?: HindsightMeta | null
): HindsightMeta {
  const next: HindsightMeta = { gate };
  if (existing?.retained !== undefined) {
    next.retained = existing.retained;
  }
  if (existing?.tags && existing.tags.length > 0) {
    next.tags = existing.tags;
  }
  return next;
}
