import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, lockProfile, profilePath, rememberProfile } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

/** A Pi session with OptChat installed, run the way a client outside the terminal runs it (T3 Code uses RPC). */
async function open(dir: string, profile?: string) {
  const contexts: Context[] = [], errors: string[] = [], events: string[] = [], asked: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      contexts.push(structuredClone(context));
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `Answer to: ${textContent(context.messages.at(-1)?.content)}` }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(dir, join(dir, 'sessions')), tools: ['read', 'zoom', 'date'] });
  if (profile) session.extensionRunner.setFlagValue('optchat-profile', profile);
  session.subscribe(event => { if (event.type === 'agent_start' || event.type === 'agent_end') events.push(event.type); });
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(),
    notify: (text, type) => { if (type === 'error') errors.push(text); },
    select: async title => { asked.push(title); return undefined; } };
  await session.bindExtensions({ uiContext, mode: 'rpc' });
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { session, contexts, errors, events, asked, close };
}

test('without a profile, Pi outside the terminal works as if OptChat were not installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-plain-'));
  createProfile('used-last'); rememberProfile('used-last'); // A session that names no profile must not take this one.
  const s = await open(dir);
  try {
    await s.session.prompt('First question');
    await s.session.prompt('Second question');
    assert.equal(s.session.getLastAssistantText(), 'Answer to: Second question');
    const last = s.contexts.at(-1)!;
    assert.deepEqual(last.messages.filter(m => m.role !== 'system').map(m => m.role), ['user', 'assistant', 'user'], 'Pi keeps its own history');
    assert.ok(!JSON.stringify(s.contexts).includes('<chat>'), 'no memory view');
    const tools = s.session.getActiveToolNames();
    assert.ok(tools.includes('read'));
    for (const name of ['zoom', 'date', 'spawn', 'tell']) assert.ok(!tools.includes(name), `${name} needs a profile`);
    assert.deepEqual(s.asked, [], 'no picker that the client may never answer');
    assert.deepEqual(s.errors, []);
    const unlock = await lockProfile(profilePath('used-last'), 'test'); await unlock(); // It was never locked.
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('outside the terminal, a busy profile ends each run with the reason, so the client is not left waiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-rpc-'));
  createProfile('busy');
  const unlock = await lockProfile(profilePath('busy'), 'busy · PID 1 · terminal');
  const s = await open(dir, 'busy');
  try {
    await s.session.prompt('hi').catch(() => {});
    assert.deepEqual(s.events, ['agent_start', 'agent_end'], 'a run starts and ends');
    assert.deepEqual(s.contexts, [], 'the model is never asked without the memory');
    assert.match(s.errors.join('\n'), /Profile already running: busy · PID 1 · terminal/);
  } finally { await s.close(); await unlock(); rmSync(dir, { recursive: true, force: true }); }
});
