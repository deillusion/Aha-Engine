/**
 * Context Compaction for Varina Agent Session.
 * Aligned with OpenAI Codex (codex-rs/core/src/compact.rs).
 */

export const PRE_TURN_THRESHOLD_TOKENS = 768_000;
export const MID_TURN_THRESHOLD_TOKENS = 896_000;

export const PRE_TURN_THRESHOLD_CHARS = Math.round(PRE_TURN_THRESHOLD_TOKENS * 2.5); // ~1.92M chars (768K tokens)
export const MID_TURN_THRESHOLD_CHARS = Math.round(MID_TURN_THRESHOLD_TOKENS * 2.5); // ~2.24M chars (896K tokens)
export const DEFAULT_KEEP_RECENT_TURNS = 2;

/**
 * Resolve pre-turn and mid-turn thresholds with token and char support.
 * Defaults to 768K tokens (or higher if specified in config/env).
 */
export function resolveCompactionThresholds(config = {}) {
  const envTokens = process.env.VARINA_PRE_TURN_COMPACTION_TOKENS ? Number(process.env.VARINA_PRE_TURN_COMPACTION_TOKENS) : null;
  const configTokens = config.compaction?.pre_turn_threshold_tokens != null
    ? Number(config.compaction.pre_turn_threshold_tokens)
    : envTokens;

  const envChars = process.env.VARINA_PRE_TURN_COMPACTION_THRESHOLD ? Number(process.env.VARINA_PRE_TURN_COMPACTION_THRESHOLD) : null;
  const configChars = config.compaction?.pre_turn_threshold != null
    ? Number(config.compaction.pre_turn_threshold)
    : envChars;

  let preTurnTokens = PRE_TURN_THRESHOLD_TOKENS;
  let preTurnChars = PRE_TURN_THRESHOLD_CHARS;

  if (configTokens != null) {
    preTurnTokens = configTokens;
    preTurnChars = Math.round(preTurnTokens * 2.5);
  } else if (configChars != null) {
    preTurnChars = configChars;
    preTurnTokens = approxTokens(preTurnChars);
  }

  const configMidTokens = config.compaction?.mid_turn_threshold_tokens != null
    ? Number(config.compaction.mid_turn_threshold_tokens)
    : (process.env.VARINA_MID_TURN_COMPACTION_TOKENS ? Number(process.env.VARINA_MID_TURN_COMPACTION_TOKENS) : null);

  const configMidChars = config.compaction?.mid_turn_threshold != null
    ? Number(config.compaction.mid_turn_threshold)
    : (process.env.VARINA_MID_TURN_COMPACTION_THRESHOLD ? Number(process.env.VARINA_MID_TURN_COMPACTION_THRESHOLD) : null);

  let midTurnTokens = Math.round(preTurnTokens * 1.15);
  let midTurnChars = Math.round(midTurnTokens * 2.5);

  if (configMidTokens != null) {
    midTurnTokens = configMidTokens;
    midTurnChars = Math.round(midTurnTokens * 2.5);
  } else if (configMidChars != null) {
    midTurnChars = configMidChars;
    midTurnTokens = approxTokens(midTurnChars);
  }

  return { preTurnTokens, preTurnChars, midTurnTokens, midTurnChars };
}

export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

export const CHECKPOINT_HEADER = `[Context Compaction Checkpoint - Previous Turns Summary]`;

/**
 * Ensure every message in the session has a valid turn property.
 * Backwards compatible with legacy sessions where message.turn was not recorded.
 */
export function ensureMessageTurns(messages) {
  if (!Array.isArray(messages)) return;
  let turn = 0;
  for (const msg of messages) {
    if (msg.turn != null && typeof msg.turn === 'number') {
      turn = Math.max(turn, msg.turn);
    } else {
      if (msg.role === 'user') turn += 1;
      msg.turn = turn;
    }
  }
}

/**
 * Estimate character volume of a single message.
 */
export function estimateMessageChars(message) {
  if (!message) return 0;
  let size = 0;
  if (typeof message.content === 'string') size += message.content.length;
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      size += (tc.name?.length || 0);
      const args = tc.arguments_json ?? tc.function?.arguments;
      size += (typeof args === 'string' ? args.length : JSON.stringify(args || '').length);
    }
  }
  if (Array.isArray(message.steps)) {
    for (const step of message.steps) {
      if (typeof step.content === 'string') size += step.content.length;
      if (typeof step.arguments_json === 'string') size += step.arguments_json.length;
      if (step.result) size += typeof step.result === 'string' ? step.result.length : JSON.stringify(step.result).length;
    }
  }
  return size;
}

/**
 * Estimate total characters across an array of messages.
 */
export function estimateMessagesChars(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((acc, msg) => acc + estimateMessageChars(msg), 0);
}

/**
 * Approximate tokens for mixed Chinese/English and code.
 */
export function approxTokens(chars) {
  return Math.ceil(chars / 2.5);
}

/**
 * Format conversation history into an input payload for the compaction summarizer LLM.
 */
export function buildCompactionInput({ previousSummary, turnMessages }) {
  const parts = [];
  if (previousSummary && typeof previousSummary === 'string' && previousSummary.trim()) {
    parts.push(`=== PREVIOUS CHECKPOINT SUMMARY ===\n${previousSummary.trim()}`);
  }
  parts.push(`=== CONVERSATION TURNS TO COMPACT ===`);
  for (const msg of turnMessages) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    let text = msg.content || '';
    if (Array.isArray(msg.steps)) {
      const toolSteps = msg.steps.filter(s => s.type === 'tool');
      if (toolSteps.length) {
        const toolDetails = toolSteps.map(s => {
          const inputPreview = JSON.stringify(s.input || s.arguments_json || {}).slice(0, 160);
          const statusStr = s.status || (s.ok ? 'completed' : 'failed');
          return `${s.name}(${inputPreview}) -> ${statusStr}`;
        }).join('; ');
        text += `\n[Tools Executed: ${toolDetails}]`;
      }
    }
    parts.push(`[Turn ${msg.turn ?? '?'}] ${roleLabel}:\n${text.trim()}`);
  }
  parts.push(`\nPlease provide the updated CONTEXT CHECKPOINT COMPACTION handoff summary according to the instructions.`);
  return parts.join('\n\n');
}

/**
 * Evaluate whether pre-turn compaction should be triggered.
 */
export function shouldCompactPreTurn({
  messages,
  compaction,
  config = {},
  currentTurn,
  force = false
}) {
  if (config.compaction?.enabled === false) return { shouldCompact: false };

  ensureMessageTurns(messages);

  const completedTurnCount = Math.max(0, (currentTurn ?? 1) - 1);
  const lastCompactedTurn = compaction?.last_compacted_turn ?? 0;
  const keepRecentTurns = Number(config.compaction?.keep_recent_turns ?? DEFAULT_KEEP_RECENT_TURNS);
  const thresholds = resolveCompactionThresholds(config);

  const maxCandidateTurn = completedTurnCount - keepRecentTurns;
  if (maxCandidateTurn <= lastCompactedTurn) {
    return { shouldCompact: false, reason: 'within_recent_turn_window' };
  }

  // Calculate candidate messages to compact:
  const candidateMessages = messages.filter(msg =>
    (msg.turn ?? 0) > lastCompactedTurn && (msg.turn ?? 0) <= maxCandidateTurn
  );

  if (!candidateMessages.length) {
    return { shouldCompact: false, reason: 'no_candidate_messages' };
  }

  // Active uncompacted message history (including recent turns):
  const uncompactedPriorMessages = messages.filter(msg => (msg.turn ?? 0) > lastCompactedTurn);
  const currentChars = estimateMessagesChars(uncompactedPriorMessages) + (compaction?.summary?.length || 0);
  const currentTokens = approxTokens(currentChars);

  if (force || currentTokens >= thresholds.preTurnTokens || currentChars >= thresholds.preTurnChars) {
    return {
      shouldCompact: true,
      fromTurn: lastCompactedTurn + 1,
      toTurn: maxCandidateTurn,
      messagesToCompact: candidateMessages,
      currentChars,
      currentTokens,
      threshold: thresholds.preTurnChars,
      thresholdTokens: thresholds.preTurnTokens
    };
  }

  return {
    shouldCompact: false,
    currentChars,
    currentTokens,
    threshold: thresholds.preTurnChars,
    thresholdTokens: thresholds.preTurnTokens,
    reason: 'below_threshold'
  };
}

/**
 * Execute pre-turn compaction via LLM gateway.
 */
export async function compactSessionHistory({
  messagesToCompact,
  previousSummary,
  gateway,
  config = {},
  sessionId,
  currentTurn,
  signal
}) {
  const compactionInput = buildCompactionInput({
    previousSummary,
    turnMessages: messagesToCompact
  });

  const messages = [
    { role: 'system', content: SUMMARIZATION_PROMPT },
    { role: 'user', content: compactionInput }
  ];

  const modelId = config.roles?.compaction ?? config.roles?.main ?? config.roles?.chair;
  const result = await gateway.invoke({
    phase: 'compaction',
    modelId,
    messages,
    context: { phase: 'compaction', currentTurn },
    logicalId: `${sessionId}:compact:T${currentTurn}`
  });

  let summary = '';
  if (typeof result === 'string') summary = result;
  else if (typeof result?.summary === 'string') summary = result.summary;
  else if (typeof result?.message === 'string') summary = result.message;
  else summary = JSON.stringify(result);

  return summary.trim();
}

/**
 * Perform mid-turn compaction on working messages during tool iteration loop.
 *
 * Folds bulky tool results from older iterations while preserving OpenAI tool_calls / tool role pairings.
 */
export function compactWorkingMessages(messages, {
  midTurnThreshold = MID_TURN_THRESHOLD_CHARS,
  currentIteration = 1,
  maxFoldedChars = 500
} = {}) {
  if (!Array.isArray(messages) || messages.length <= 4) {
    return { compacted: false, charsBefore: 0, charsAfter: 0 };
  }

  const charsBefore = estimateMessagesChars(messages);
  if (charsBefore <= midTurnThreshold) {
    return { compacted: false, charsBefore, charsAfter: charsBefore };
  }

  let foldedCount = 0;

  // We scan backward to find the most recent assistant tool_calls batch.
  // Tool responses belonging to earlier iterations (prior to current iteration) can be safely folded.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Case 1: Standard OpenAI tool response message
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.length > maxFoldedChars) {
        try {
          const parsed = JSON.parse(msg.content);
          if (!parsed._folded) {
            let briefResult = '';
            if (parsed.result) {
              const resStr = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
              briefResult = resStr.slice(0, 180) + (resStr.length > 180 ? '...[truncated]' : '');
            }
            msg.content = JSON.stringify({
              id: parsed.id ?? msg.tool_call_id,
              name: parsed.name ?? 'tool',
              ok: parsed.ok ?? true,
              result_preview: briefResult,
              _folded: true,
              _note: 'Tool result folded for mid-turn context conservation; detailed output was processed in earlier step.'
            });
            foldedCount++;
          }
        } catch {
          // If not valid JSON, truncate plain string
          msg.content = msg.content.slice(0, maxFoldedChars) + '\n... [Folded for mid-turn context compaction]';
          foldedCount++;
        }
      }
    }

    // Case 2: Legacy fallback user message containing formatted tool results
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('Tool results:')) {
      if (msg.content.length > maxFoldedChars && !msg.content.includes('[Folded for mid-turn')) {
        msg.content = msg.content.slice(0, maxFoldedChars) + '\n... [Folded for mid-turn context compaction]';
        foldedCount++;
      }
    }
  }

  const charsAfter = estimateMessagesChars(messages);
  return {
    compacted: foldedCount > 0,
    foldedCount,
    charsBefore,
    charsAfter
  };
}
