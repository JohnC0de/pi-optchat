import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
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
  payload.cache_control = { type: 'ephemeral' };
  return payload;
}

/** Providers whose GPT-5.6+ models cache only up to explicit breakpoints (or a whole identical request), so a view followed by a new
 * input is never reused without marks. Measured: OpenAI itself caches the view's prefix without marks and, signed in with ChatGPT,
 * rejects them with a 400. */
const NEEDS_BREAKPOINTS = new Set(['github-copilot']);
const explicitCaching = (model: Model<Api> | undefined) =>
  model?.compat && 'supportsExplicitPromptCacheMode' in model.compat ? model.compat.supportsExplicitPromptCacheMode : undefined;

/** Copilot serves OpenAI's models, but pi-ai keeps OpenAI's "explicit prompt caching" flag only on OpenAI's own entry of the model. */
export function takesBreakpoints(model: Model<Api>, registry: Pick<ModelRegistry, 'find'>) {
  return model.api === 'openai-responses' && NEEDS_BREAKPOINTS.has(model.provider)
    && (explicitCaching(model) ?? explicitCaching(registry.find('openai', model.id)) ?? false);
}

/** OpenAI Responses: a breakpoint after each stable cut and at the view's end, so calls with the same view share it. */
export function breakpointPayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.input)) return payload;
  for (const item of payload.input) {
    if (!record(item) || item.role !== 'user' || !Array.isArray(item.content)) continue;
    const at = item.content.findIndex((part: unknown) => record(part) && part.type === 'input_text' && typeof part.text === 'string' && isView(part.text));
    if (at < 0) continue;
    item.content.splice(at, 1, ...splitView(item.content[at].text).map(text => ({ type: 'input_text', text, prompt_cache_breakpoint: { mode: 'explicit' } })));
    break;
  }
  return payload;
}
