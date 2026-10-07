import { isView } from './memory.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable, line-aligned cuts from recipe §8. Text is preserved byte for byte. */
export function splitView(text: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (const mark of [50_000, 80_000, 100_000]) {
    if (mark >= text.length) break;
    const cut = text.lastIndexOf('\n', mark) + 1;
    if (cut > offset) { pieces.push(text.slice(offset, cut)); offset = cut; }
  }
  pieces.push(text.slice(offset));
  return pieces;
}

/** Anthropic: three stable view marks plus automatic end-of-request caching. */
export function cachePayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    const pieces = splitView(message.content[at].text);
    const blocks = pieces.map((text, j) => ({ type: 'text', text, ...(j < pieces.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));
    message.content.splice(at, 1, ...blocks);
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  // Pi's default system/recent-message marks would exceed Anthropic's four-mark limit.
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  markRequestEnd(messages);
  return payload;
}

const CACHEABLE = new Set(['text', 'image', 'document', 'tool_result']);
/** The recipe's end-of-request mark, on the last block rather than as Anthropic's top-level automatic mark, which
 * means the same. A proxy may give that block its own TTL (CLIProxyAPI gives OAuth requests 1h), and Anthropic
 * refuses a top-level mark whose TTL differs from the block's. */
function markRequestEnd(messages: unknown[]) {
  const last = messages.at(-1);
  if (!record(last)) return;
  if (typeof last.content === 'string') {
    if (last.content) last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (!Array.isArray(last.content)) return;
  for (let i = last.content.length - 1; i >= 0; i--) {
    const block: unknown = last.content[i];
    if (!record(block) || typeof block.type !== 'string' || !CACHEABLE.has(block.type)) continue;
    if (block.type === 'text' && !block.text) continue;
    block.cache_control ??= { type: 'ephemeral' };
    return;
  }
}
