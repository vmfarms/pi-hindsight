/**
 * autoMM — plugin-side mental-model selection and injection.
 *
 * Goal: when autoRecall returns results, additionally inject the content of
 * matching mental-model handbooks into the prompt context. The model gets
 * handbook material without needing to call hindsight_reflect itself.
 *
 * Algorithm: for each registered MM, count autoRecall items whose tag set is
 * a superset of the MM's tag filter (AND semantics). MMs whose match count
 * passes the threshold (absolute count OR ratio of recall items) are ranked
 * by match count; the top-K MMs have their content fetched and injected.
 *
 * The selection is deterministic and runs entirely from the recall response
 * — no extra LLM call, no embedding step. The empirical justification is in
 * test-prompts/analysis/iter-3-handoff.md Appendix A.
 */

import type { RecallResponse } from "@vectorize-io/hindsight-client";
import type { HindsightClientWrapper } from "./client";

/** Metadata about a registered mental model. */
export interface MentalModelMeta {
  id: string;
  name: string;
  tags: string[];
}

/** A mental model that won selection, with score detail kept for diagnostics. */
export interface SelectedMentalModel {
  meta: MentalModelMeta;
  matchCount: number;
  matchRatio: number;
}

/** Result of fetching a selected MM's content, ready to inject. */
export interface FetchedMentalModel extends SelectedMentalModel {
  content: string;
}

/** Tunable knobs for selection. */
export interface AutoMMSelectionConfig {
  autoMMTopK: number;
  autoMMMinMatchCount: number;
  autoMMMinMatchRatio: number;
}

/** Audit-trail entry written via pi.appendEntry. */
export interface AutoMMEntry {
  timestamp: string;
  totalRecallItems: number;
  totalMentalModels: number;
  selected: Array<{
    id: string;
    name: string;
    matchCount: number;
    matchRatio: number;
    contentLength: number;
  }>;
  considered: Array<{
    id: string;
    matchCount: number;
    matchRatio: number;
    passedThreshold: boolean;
  }>;
}

/**
 * Pure selection logic — given recall results and the list of MMs, pick the
 * top-K MMs by tag-intersection match count, gated by absolute count and ratio
 * thresholds.
 *
 * Exported for unit testing.
 */
export function selectMentalModels(
  recallResults: ReadonlyArray<RecallResponse["results"][number]>,
  allMMs: ReadonlyArray<MentalModelMeta>,
  config: AutoMMSelectionConfig
): {
  selected: SelectedMentalModel[];
  considered: Array<{
    meta: MentalModelMeta;
    matchCount: number;
    matchRatio: number;
    passedThreshold: boolean;
  }>;
} {
  const considered: Array<{
    meta: MentalModelMeta;
    matchCount: number;
    matchRatio: number;
    passedThreshold: boolean;
  }> = [];

  if (recallResults.length === 0 || allMMs.length === 0 || config.autoMMTopK <= 0) {
    return { selected: [], considered };
  }

  // Pre-compute per-item tag sets so the inner loop is a Set membership test
  // rather than a linear scan.
  const itemTagSets = recallResults.map((r) => new Set(r.tags ?? []));

  const candidates: SelectedMentalModel[] = [];
  for (const mm of allMMs) {
    // MMs with no tag filter would match every item and dominate selection.
    // Skip them — they're not useful for tag-routed injection.
    if (!mm.tags || mm.tags.length === 0) {
      considered.push({ meta: mm, matchCount: 0, matchRatio: 0, passedThreshold: false });
      continue;
    }

    let matchCount = 0;
    for (const itemTags of itemTagSets) {
      let allPresent = true;
      for (const t of mm.tags) {
        if (!itemTags.has(t)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) matchCount++;
    }

    const matchRatio = matchCount / recallResults.length;
    const passedThreshold =
      matchCount >= config.autoMMMinMatchCount || matchRatio >= config.autoMMMinMatchRatio;

    considered.push({ meta: mm, matchCount, matchRatio, passedThreshold });

    if (passedThreshold) {
      candidates.push({ meta: mm, matchCount, matchRatio });
    }
  }

  // Higher match count wins. Stable sort on (count desc, name asc) so the
  // selection is deterministic for ties.
  candidates.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return a.meta.name.localeCompare(b.meta.name);
  });

  return { selected: candidates.slice(0, config.autoMMTopK), considered };
}

/** Format the fenced custom-message content for the LLM. */
export function formatMMContent(blocks: ReadonlyArray<FetchedMentalModel>): string {
  const sections = blocks.map((b) => {
    const trimmed = b.content.trim();
    return `## ${b.meta.name}\n\n${trimmed}`;
  });
  return `<hindsight_handbooks>\n${sections.join("\n\n---\n\n")}\n</hindsight_handbooks>`;
}

/** Custom message shape for autoMM. Mirrors the recall message envelope. */
export interface AutoMMMessageDetails {
  /** Per-MM short summary for the renderer. */
  selected: Array<{ id: string; name: string; matchCount: number; contentLength: number }>;
  /** Full concatenated handbook content (for expanded renderer). */
  body: string;
}

export interface AutoMMMessage {
  role: "custom";
  customType: "hindsight-mm";
  content: string;
  display: boolean;
  timestamp: number;
  details: AutoMMMessageDetails;
}

export function buildAutoMMMessage(
  blocks: ReadonlyArray<FetchedMentalModel>,
  display: boolean
): AutoMMMessage | null {
  if (blocks.length === 0) return null;
  const body = formatMMContent(blocks);
  return {
    role: "custom",
    customType: "hindsight-mm",
    content: body,
    display,
    timestamp: Date.now(),
    details: {
      selected: blocks.map((b) => ({
        id: b.meta.id,
        name: b.meta.name,
        matchCount: b.matchCount,
        contentLength: b.content.length,
      })),
      body,
    },
  };
}

/** Client surface autoMM needs — narrow interface for test injection. */
export interface AutoMMClient {
  listMentalModels: HindsightClientWrapper["listMentalModels"];
  getMentalModel: HindsightClientWrapper["getMentalModel"];
}

/**
 * Orchestrator: select matching MMs, fetch their content, build the injection
 * message. Returns null if autoMM should not inject this turn (disabled, no
 * recall items, no matches, all fetches failed, etc.).
 *
 * `mmListCache` lets the caller hand in a pre-fetched MM list and avoid the
 * per-turn list round-trip. Pass undefined to fetch fresh.
 */
export async function injectAutoMM(opts: {
  client: AutoMMClient;
  recallResults: ReadonlyArray<RecallResponse["results"][number]>;
  config: AutoMMSelectionConfig & { autoMMEnabled: boolean; autoMMDisplay: boolean };
  signal?: AbortSignal;
  mmListCache?: ReadonlyArray<MentalModelMeta>;
  /** Called once with the audit-trail entry, regardless of whether a message is built. */
  onAudit?: (entry: AutoMMEntry) => void;
}): Promise<{
  message: AutoMMMessage | null;
  mmList: MentalModelMeta[] | null;
}> {
  const { client, recallResults, config, signal, mmListCache, onAudit } = opts;

  if (!config.autoMMEnabled) return { message: null, mmList: null };
  if (recallResults.length === 0) return { message: null, mmList: null };

  // Fetch MM list if not cached.
  let mmList: MentalModelMeta[];
  if (mmListCache && mmListCache.length > 0) {
    mmList = mmListCache.slice();
  } else {
    const listResult = await client.listMentalModels(signal);
    if (!listResult.success || !listResult.items) {
      console.warn("pi-hindsight: autoMM failed to list mental models:", listResult.error);
      return { message: null, mmList: null };
    }
    mmList = listResult.items;
  }

  const { selected, considered } = selectMentalModels(recallResults, mmList, config);

  if (selected.length === 0) {
    onAudit?.({
      timestamp: new Date().toISOString(),
      totalRecallItems: recallResults.length,
      totalMentalModels: mmList.length,
      selected: [],
      considered: considered.map((c) => ({
        id: c.meta.id,
        matchCount: c.matchCount,
        matchRatio: c.matchRatio,
        passedThreshold: c.passedThreshold,
      })),
    });
    return { message: null, mmList };
  }

  // Fetch each selected MM's content in parallel. Skip empty ones.
  const fetched: FetchedMentalModel[] = [];
  await Promise.all(
    selected.map(async (sel) => {
      const res = await client.getMentalModel(sel.meta.id, signal);
      if (!res.success) {
        console.warn(
          `pi-hindsight: autoMM failed to fetch MM ${sel.meta.id}: ${res.error}`
        );
        return;
      }
      const body = (res.content ?? "").trim();
      if (!body) return;
      fetched.push({ ...sel, content: body });
    })
  );

  // Preserve the selection order from selectMentalModels (sorted by count desc).
  fetched.sort((a, b) => b.matchCount - a.matchCount);

  const message = buildAutoMMMessage(fetched, config.autoMMDisplay);

  onAudit?.({
    timestamp: new Date().toISOString(),
    totalRecallItems: recallResults.length,
    totalMentalModels: mmList.length,
    selected: fetched.map((f) => ({
      id: f.meta.id,
      name: f.meta.name,
      matchCount: f.matchCount,
      matchRatio: f.matchRatio,
      contentLength: f.content.length,
    })),
    considered: considered.map((c) => ({
      id: c.meta.id,
      matchCount: c.matchCount,
      matchRatio: c.matchRatio,
      passedThreshold: c.passedThreshold,
    })),
  });

  return { message, mmList };
}
