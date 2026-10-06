import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

/** A fake Anthropic model whose calls answer and finish only when the test says so. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compactor-'));
  const calls: { source: string; answer: () => void; finish: () => void; fail: () => void }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const source = textContent(context.messages.findLast(m => m.role === 'user')?.content).split('\n').at(-2) ?? ''; // the last input line, before </input>
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `summary of ${source}` }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      stream.push({ type: 'start', partial: message });
      const step = <T>() => { let resolve = (_: T) => {}; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
      const answered = step<boolean>(), finished = step<void>();
      calls.push({ source, answer: () => answered.resolve(true), fail: () => answered.resolve(false), finish: () => finished.resolve() });
      void (async () => {
        if (!await answered.promise) {
          message.stopReason = 'error'; message.errorMessage = 'overloaded';
          stream.push({ type: 'error', reason: 'error', error: message }); return stream.end();
        }
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message });
        await finished.promise;
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }));
  // Long enough for a cache mark, so the first 50k characters are a shared, cacheable prefix.
  const view = `<chat>\n${'0+1|user: an old remembered line\n'.repeat(2000)}</chat>`;
  // The compactor only sees sources over NODE bytes; the fake model reads just the last line.
  const run = (source: string, context = view, signal = new AbortController().signal) => compress({ context, source: `${'x'.repeat(600)}\n${source}`, merge: false }, signal);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { calls, run, settle, view };
}

test('parallel calls on a cold view wait until one call has started answering, and a warm view skips the wait', async () => {
  const { calls, run, settle, view } = await setup();
  const replies = ['a', 'b', 'c'].map(source => run(source));
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a'], 'only the primer starts while the shared view is cold');
  calls[0].answer();
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a', 'b', 'c'], 'the rest start together once the primer answers, before it finishes');
  calls.forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['summary of a', 'summary of b', 'summary of c']);
  const warm = run('d', view.replace('</chat>', 'user: one new line\n</chat>'));
  await settle();
  assert.equal(calls.length, 4, 'a newer view with the same cached prefix starts right away');
  calls[3].answer(); calls[3].finish();
  await warm;
});

test('a failing primer releases the waiting calls instead of hanging them', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const replies = ['a', 'b', 'c'].map(source => run(source).catch((error: Error) => error.message));
  await settle();
  calls[0].fail();
  await settle();
  assert.equal(calls.length, 2, 'the next waiter primes in its place');
  calls[1].answer();
  await settle();
  calls.slice(1).forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['overloaded', 'summary of b', 'summary of c']);
});

test('a waiting call that is cancelled stops at once without ever calling the model', { timeout: 5000 }, async () => {
  const { calls, run, settle, view } = await setup();
  const primer = run('a'), cancel = new AbortController();
  const waiter = run('b', view, cancel.signal);
  await settle();
  cancel.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  calls[0].answer(); calls[0].finish();
  await primer;
  assert.deepEqual(calls.map(c => c.source), ['a']);
});

/** Fake OpenAI Responses models that record the content parts OptChat's payload hook sends, in the order calls start. */
async function responses(models: string[], compat: Record<string, { supportsExplicitPromptCacheMode: boolean }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compactor-'));
  const sent: { model: string; parts: unknown[] }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  for (const provider of new Set(models.map(m => m.split('/')[0]))) runtime.registerProvider(provider, {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-responses',
    models: models.filter(m => m.startsWith(provider + '/')).map(m => ({ id: m.slice(provider.length + 1), name: m, compat: compat[m], reasoning: false, input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const request = context.messages.find(m => m.role === 'user')!;
        const content = Array.isArray(request.content) ? request.content.flatMap(c => c.type === 'text' ? [{ type: 'input_text', text: c.text }] : []) : [];
        const payload = await options?.onPayload?.({ model: model.id, input: [{ role: 'user', content }] }, model) as { input: { content: unknown[] }[] };
        sent.push({ model: `${model.provider}/${model.id}`, parts: payload.input[0].content });
        const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'summary' }], api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
        stream.push({ type: 'start', partial: message });
        await new Promise(resolve => setTimeout(resolve, 20));
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime);
  const view = `<chat>\n${'0+1|user: an old remembered line\n'.repeat(2000)}</chat>`;
  const compressors = new Map(models.map(m => {
    const [provider, model] = [m.split('/')[0], m.slice(m.indexOf('/') + 1)];
    return [m, createCompressor(registry, () => ({ provider, model, thinking: 'off' }))];
  }));
  const run = (model: string, source: string) => compressors.get(model)!({ context: view, source: `${'x'.repeat(600)}\n${source}`, merge: false }, new AbortController().signal);
  return { sent, run, view };
}

const marked = (parts: unknown[]) => parts.filter(p => JSON.stringify(p).includes('"prompt_cache_breakpoint":{"mode":"explicit"}')).length;

test('Copilot\'s GPT-5.6+ summaries put a cache breakpoint after each stable cut and the view, so a new input reuses the view', async () => {
  // No flag on these fake Copilot entries: like pi-ai's, they take it from OpenAI's own entry of the model.
  const models = ['github-copilot/gpt-6.1-sol', 'github-copilot/gpt-5.6-luna'];
  const { sent, run, view } = await responses(models);
  for (const model of models) await run(model, 'a');
  assert.equal(sent.length, 2);
  for (const { model, parts } of sent) {
    assert.equal(marked(parts), 2, `${model}: a ~66KB view has one stable cut plus its end`);
    assert.equal(parts.slice(0, 2).map(p => (p as { text: string }).text).join(''), view, 'the view text is unchanged');
    assert.equal(marked(parts.slice(2)), 0, 'the new input is not marked');
  }
});

test('other models are sent as before: no breakpoints, no waiting on a primer', async () => {
  // Copilot 400s marks on gpt-5.5 and older; OpenAI caches the view without them and rejects them on a ChatGPT sign-in.
  const models = ['github-copilot/gpt-5.5', 'github-copilot/grok-4.7', 'openai/gpt-6.1-sol'];
  const { sent, run } = await responses(models, { 'openai/gpt-6.1-sol': { supportsExplicitPromptCacheMode: true } });
  for (const model of models) await run(model, 'a');
  assert.deepEqual(sent.map(s => [s.model, s.parts.length, marked(s.parts)]), models.map(m => [m, 2, 0]));
  const parallel = ['b', 'c'].map(source => run('openai/gpt-6.1-sol', source));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 5, 'both calls start at once');
  await Promise.all(parallel);
});

test('parallel Sol calls on a cold view wait for one to start answering, so they read its cache instead of all writing it', async () => {
  const { sent, run } = await responses(['github-copilot/gpt-6.1-sol']);
  const parallel = ['a', 'b', 'c'].map(source => run('github-copilot/gpt-6.1-sol', source));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1, 'only the primer is sent while the view is cold');
  await Promise.all(parallel);
  assert.equal(sent.length, 3);
});
