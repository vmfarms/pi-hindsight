/**
 * Shared utilities for slash commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../client";
import { expandSessionObservationScopes, type HindsightConfig } from "../config";
import {
  buildDocumentTags,
  buildMessageArrayFromParsedSession,
  getHindsightContextFromEntries,
  parseSessionFile,
} from "../document";
import { getHindsightMeta, shouldSessionBeRetained } from "../meta";
import { deleteAutoQueue } from "../queue";
import { extractParentSessionId, getProjectName, getSessionDisplayName } from "../utils";

/** Notification level for early-exit results from {@link parseCurrentSession}. */
export type ParseExitLevel = "error" | "warning";

/** Early-exit result from {@link parseCurrentSession} (no session file, retention disabled, etc.). */
export interface ParseExitResult {
  /** Human-readable message describing why parsing did not proceed. */
  message: string;
  /** Notification level — "error" for hard failures, "warning" for user-configured blocks. */
  level: ParseExitLevel;
}

/** Result of parsing a session file for subcommand handlers. */
export interface ParsedSessionResult {
  /** The parsed session data ready for retention or disk output. */
  parsedSession: {
    documentId: string;
    context: string;
    tags: string[];
    timestamp: string;
    messages: object[];
    parsedAt: string;
    sessionId: string;
    parentSessionId?: string;
    cwd: string;
  };
  /** Path where the parsed session file was written on disk. */
  outputPath: string;
}

/** Return type of {@link parseCurrentSession}: success data or a structured early exit. */
export type ParseCurrentSessionResult = ParsedSessionResult | ParseExitResult;

/**
 * Parse the current session file into a structured object for retention/export.
 *
 * Validates the session file exists, checks retention state, builds document tags
 * and context, and writes the parsed session to disk for later review.
 * Returns a {@link ParsedSessionResult} on success, or a {@link ParseExitResult} on early exit
 * (e.g. no session file, retention disabled, parent not found).
 */
export function parseCurrentSession(
  ctx: ExtensionContext,
  config: HindsightConfig
): ParseCurrentSessionResult {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !existsSync(sessionFile)) {
    return { message: "No session file found", level: "error" };
  }

  const { header, entries: originalEntries } = parseSessionFile(sessionFile);
  const { messages, documentId, warning } = buildMessageArrayFromParsedSession(
    header,
    originalEntries,
    config
  );

  if (warning) {
    return { message: warning, level: "warning" };
  }

  if (messages.length === 0) {
    return { message: "No messages to parse", level: "warning" };
  }

  // Check retention state
  if (!shouldSessionBeRetained(originalEntries, config)) {
    return {
      message:
        "Session does not allow retention. Use /hindsight toggle-retain to enable retention.",
      level: "warning",
    };
  }

  // Build tags from metadata
  const parsedMeta = getHindsightMeta(originalEntries);
  const sessionTags = parsedMeta?.tags ?? [];
  const sessionName = getSessionDisplayName(
    ctx.sessionManager.getSessionName.bind(ctx.sessionManager),
    ctx.sessionManager.getEntries.bind(ctx.sessionManager)
  );

  const parentSessionId = extractParentSessionId(header.parentSession);
  const tags = buildDocumentTags(header, config, { sessionTags, parentSessionId });
  const context = getHindsightContextFromEntries(originalEntries, config, sessionName);
  const parsedSession = {
    documentId,
    context,
    tags,
    timestamp: header.timestamp,
    messages,
    parsedAt: new Date().toISOString(),
    sessionId: header.id,
    parentSessionId,
    cwd: header.cwd,
  };

  // Write parsed session to disk for later review
  const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
  if (!existsSync(parsedDir)) {
    mkdirSync(parsedDir, { recursive: true });
  }
  const outputPath = join(parsedDir, `${header.id}.json`);
  writeFileSync(outputPath, `${JSON.stringify(parsedSession)}\n`, "utf8");

  return { parsedSession, outputPath };
}

/**
 * Call client.retain with standard options (updateMode=replace, entities from config).
 * Throws on failure.
 */
export async function upsertToHindsight(
  client: HindsightClientWrapper,
  params: {
    content: string;
    documentId: string;
    context: string;
    timestamp: string;
    tags: string[];
    sessionId: string;
    parentSessionId?: string;
    sessionCwd: string;
  },
  config: HindsightConfig,
  signal?: AbortSignal
): Promise<void> {
  // Expand placeholders in observation scopes
  const expandedScopes = expandSessionObservationScopes(
    config,
    params.sessionId,
    params.parentSessionId,
    params.sessionCwd,
    getProjectName(params.sessionCwd)
  );

  const result = await client.retain(
    {
      content: params.content,
      documentId: params.documentId,
      context: params.context,
      timestamp: params.timestamp,
      tags: params.tags,
      updateMode: "replace",
      entities: config.entities.length > 0 ? config.entities : undefined,
      observationScopes: expandedScopes,
    },
    signal
  );

  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
}

/**
 * Parse a session file at a given absolute path for retention/export.
 *
 * Mirrors {@link parseCurrentSession} for an arbitrary on-disk JSONL instead of the
 * running session. Used by the `--path` variant of `parse-and-upsert-session` for
 * deliberate ingestion of named sessions (e.g. mission-version regression baselines).
 *
 * Skips the running-session retention-state check since the caller is explicitly
 * naming the file to ingest. The session-ID collision check (refuse to re-ingest the
 * currently-running session) is performed against `opts.currentSessionId` if provided.
 */
export function parseSessionFromPath(
  sessionPath: string,
  config: HindsightConfig,
  opts: { currentSessionId?: string | null } = {}
): ParseCurrentSessionResult {
  if (!existsSync(sessionPath)) {
    return { message: `Session file not found: ${sessionPath}`, level: "error" };
  }

  // Cheap shape check before full parse — validates this is actually a pi session JSONL.
  let firstLine: string;
  try {
    firstLine = readFileSync(sessionPath, "utf-8").split("\n", 1)[0] ?? "";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { message: `Failed to read session file: ${msg}`, level: "error" };
  }
  try {
    const firstParsed = JSON.parse(firstLine);
    if (firstParsed?.type !== "session") {
      return {
        message: `Not a session JSONL: first line type is "${firstParsed?.type ?? "unknown"}" (expected "session")`,
        level: "error",
      };
    }
  } catch {
    return { message: "Not a session JSONL: first line is not valid JSON", level: "error" };
  }

  let parsed: ReturnType<typeof parseSessionFile>;
  try {
    parsed = parseSessionFile(sessionPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { message: `Failed to parse session file: ${msg}`, level: "error" };
  }
  const { header, entries: originalEntries } = parsed;

  if (opts.currentSessionId && header.id === opts.currentSessionId) {
    return {
      message: "Refusing to ingest the currently-running session (concurrent-write risk)",
      level: "error",
    };
  }

  const { messages, documentId, warning } = buildMessageArrayFromParsedSession(
    header,
    originalEntries,
    config
  );

  if (warning) {
    return { message: warning, level: "warning" };
  }

  if (messages.length === 0) {
    return { message: "No messages to parse", level: "warning" };
  }

  // Build tags from in-file metadata. No sessionManager — derive display name from
  // parsed entries (manual title via sessionManager.getSessionName is not available off-session).
  const parsedMeta = getHindsightMeta(originalEntries);
  const sessionTags = parsedMeta?.tags ?? [];
  const sessionName = getSessionDisplayName(
    () => undefined,
    () => originalEntries
  );

  const parentSessionId = extractParentSessionId(header.parentSession);
  const tags = buildDocumentTags(header, config, { sessionTags, parentSessionId });
  const context = getHindsightContextFromEntries(originalEntries, config, sessionName);
  const parsedSession = {
    documentId,
    context,
    tags,
    timestamp: header.timestamp,
    messages,
    parsedAt: new Date().toISOString(),
    sessionId: header.id,
    parentSessionId,
    cwd: header.cwd,
  };

  // Write parsed session to disk for later review
  const parsedDir = join(getAgentDir(), "extensions", "pi-hindsight", "parsed-sessions");
  if (!existsSync(parsedDir)) {
    mkdirSync(parsedDir, { recursive: true });
  }
  const outputPath = join(parsedDir, `${header.id}.json`);
  writeFileSync(outputPath, `${JSON.stringify(parsedSession)}\n`, "utf8");

  return { parsedSession, outputPath };
}

/** Options for {@link parseAndUpsertSession}. */
export interface ParseAndUpsertOptions {
  /**
   * Absolute path to a session JSONL to ingest instead of the running session.
   * When provided, the running-session retention check is skipped (explicit ingest)
   * and the auto-queue is NOT cleared (it belongs to a different session).
   */
  sessionPath?: string;
}

/**
 * Parse a session file and upsert to Hindsight in one step.
 *
 * By default operates on the running session via {@link parseCurrentSession}.
 * When `options.sessionPath` is provided, operates on that on-disk JSONL via
 * {@link parseSessionFromPath} instead. Returns a description of the result, or throws on error.
 */
export async function parseAndUpsertSession(
  ctx: ExtensionContext,
  config: HindsightConfig,
  client: HindsightClientWrapper,
  options: ParseAndUpsertOptions = {}
): Promise<{ message: string; level: "info" | ParseExitLevel }> {
  const result = options.sessionPath
    ? parseSessionFromPath(options.sessionPath, config, {
        currentSessionId: ctx.sessionManager.getSessionId(),
      })
    : parseCurrentSession(ctx, config);

  if ("message" in result) {
    return { message: result.message, level: result.level };
  }

  const { parsedSession } = result;

  await upsertToHindsight(
    client,
    {
      content: JSON.stringify(parsedSession.messages),
      documentId: parsedSession.documentId,
      context: parsedSession.context,
      timestamp: parsedSession.timestamp,
      tags: parsedSession.tags,
      sessionId: parsedSession.sessionId,
      parentSessionId: parsedSession.parentSessionId,
      sessionCwd: parsedSession.cwd,
    },
    config,
    ctx.signal
  );

  // Clear auto-queued messages to prevent duplication — the full session was just upserted.
  // Note: Tool queue is NOT deleted because tool retains are separate documents
  // (raw content with their own tags/metadata), not included in the session upsert.
  // For --path ingest, skip queue cleanup: the queue (if any) belongs to a different session.
  if (!options.sessionPath) {
    deleteAutoQueue(parsedSession.sessionId);
  }

  return {
    message: `Parsed and upserted ${parsedSession.messages.length} messages`,
    level: "info",
  };
}
