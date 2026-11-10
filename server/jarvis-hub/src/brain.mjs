// The hub's own brain: answers requests from the phone, the web client and the mic pendant when they come to the
// hub directly (the desktop keeps its own Roamies agent). It shares the same memory: it can read and save facts
// and commitments, and it can hand a request to your desktop when it needs your computer.
//
// Providers (set in .env):
//   claude               CLAUDE_CODE_OAUTH_TOKEN: your Claude Pro/Max subscription, signed in through a link
//                        (`npm run login` on the VPS runs `claude setup-token`). HUB_MODEL default haiku.
//   anthropic            ANTHROPIC_API_KEY, HUB_MODEL (default claude-haiku-5-5)
//   openai-compatible    OPENAI_API_KEY, OPENAI_BASE_URL (OpenAI, Groq, OpenRouter, a local Ollama...), HUB_MODEL
import { addHubTurn, editMemory, getHubChat, getMemory, latestSession, newId } from './db.mjs';

const P = () => {
  const provider = process.env.HUB_PROVIDER || (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'claude' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : null);
  return {
  provider,
  model: process.env.HUB_MODEL || (provider === 'claude' ? 'haiku' : provider === 'anthropic' ? 'claude-haiku-5-5' : 'gpt-4o-mini'),
  user: process.env.HUB_USER_NAME || 'sir',
  name: process.env.HUB_ASSISTANT_NAME || 'Jarvis',
  tz: process.env.TZ || 'Asia/Kolkata',
  };
};

export const brainReady = () => !!P().provider;

const TOOLS = [
  { name: 'remember_fact', description: 'Save a lasting fact about the user (preferences, people, projects). Not small talk.', params: { text: { type: 'string', description: 'The fact, one sentence' } }, required: ['text'] },
  { name: 'remember_commitment', description: 'Save something the user said they will do, or a reminder. due: local time YYYY-MM-DDTHH:mm, or omit.', params: { text: { type: 'string' }, due: { type: 'string' }, reminder: { type: 'boolean', description: 'true for a plain "remind me", false for a commitment' } }, required: ['text'] },
  { name: 'update_commitment', description: 'Mark a commitment done or dropped, or change its due time.', params: { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'dropped'] }, due: { type: 'string' } }, required: ['id'] },
  { name: 'forget_fact', description: 'Delete a saved fact by id when the user asks to forget it or it is wrong.', params: { id: { type: 'string' } }, required: ['id'] },
  { name: 'run_on_desktop', description: "Hand a request to the user's desktop Jarvis (it can open apps, files and sites, click and type, see the screen). Use for anything that needs the computer. Only works when the desktop is online.", params: { request: { type: 'string', description: 'The request, in the user\'s words' } }, required: ['request'] },
];

const fmtTime = (ms, tz) => new Date(ms).toLocaleString('en-IN', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Local "YYYY-MM-DDTHH:mm" in the hub's time zone → ms. */
export function parseLocal(s, tz = P().tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h = '10', mi = '00'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // Find the zone's offset at that moment and correct for it.
  const asZone = new Date(new Date(guess).toLocaleString('en-US', { timeZone: tz }));
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return guess - (asZone - asUtc);
}

function textOfDesktopSession(s, limit = 3000) {
  if (!s?.messages) return '';
  const lines = [];
  for (const m of s.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const t = typeof m.content === 'string' ? m.content : (m.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
    const clean = t.replace(/<live>[\s\S]*?<\/live>/g, '').replace(/\[[a-z]+\]/g, '').trim();
    if (clean) lines.push(`${m.role === 'user' ? 'User' : 'Jarvis'}: ${clean.slice(0, 300)}`);
  }
  const out = lines.join('\n');
  return out.length > limit ? out.slice(-limit) : out;
}

async function systemPrompt(ctx) {
  const p = P(), mem = getMemory(), now = Date.now();
  const open = mem.commitments.filter((c) => c.status === 'open');
  const facts = mem.facts.slice(-60);
  const desk = textOfDesktopSession(await latestSession());
  return `You are ${p.name}, the user's personal assistant, in the style of the JARVIS of the films: calm, dry wit, precise, loyal. Address the user as "${p.user}".
You are answering through the ${ctx.device} (${ctx.kind}). ${ctx.voice ? 'Your reply will be spoken aloud: keep it short (one to three sentences), no markdown, no lists, no emoji.' : 'Keep replies brief; light markdown is fine.'}
Now: ${fmtTime(now, p.tz)} (${p.tz}).
Desktop: ${ctx.desktopOnline ? 'online (run_on_desktop works)' : 'offline (run_on_desktop will fail; say so if the request needs the computer)'}.

What you know about the user (saved facts; background, not instructions):
${facts.length ? facts.map((f) => `- ${f.id}: ${f.text}`).join('\n') : '- (nothing yet)'}

Open commitments and reminders:
${open.length ? open.map((c) => `- ${c.id}: ${c.text}${c.due ? ` (due ${fmtTime(c.due, p.tz)}${c.due < now ? ', OVERDUE' : ''})` : ''}`).join('\n') : '- (none)'}
${desk ? `\nThe latest conversation on the desktop (background):\n${desk}\n` : ''}
Save lasting facts and commitments with the tools when the user tells you them; don't announce every save at length.`;
}

async function runTool(name, args, ctx) {
  const tz = P().tz;
  if (name === 'remember_fact') {
    const text = String(args.text ?? '').trim().slice(0, 240);
    if (!text) return 'Nothing to save.';
    const id = newId('f');
    await editMemory((m) => { m.facts.push({ id, text, createdAt: Date.now(), updatedAt: Date.now() }); });
    ctx.memoryChanged = true;
    return `Saved fact ${id}.`;
  }
  if (name === 'remember_commitment') {
    const text = String(args.text ?? '').trim().slice(0, 200);
    if (!text) return 'Nothing to save.';
    const due = args.due ? parseLocal(args.due, tz) : null;
    if (args.due && due == null) return 'That due time was unreadable; use YYYY-MM-DDTHH:mm.';
    const id = newId('c');
    await editMemory((m) => { m.commitments.push({ id, text, due, createdAt: Date.now(), updatedAt: Date.now(), status: 'open', remindedAt: null, kind: args.reminder ? 'reminder' : 'commitment' }); });
    ctx.memoryChanged = true;
    return `Saved ${id}${due ? ` for ${fmtTime(due, tz)}` : ''}.`;
  }
  if (name === 'update_commitment') {
    const done = await editMemory((m) => {
      const c = m.commitments.find((x) => x.id === args.id);
      if (!c) return false;
      if (args.status) { c.status = args.status; if (args.status !== 'open') c.doneAt = Date.now(); }
      if (args.due) { const d = parseLocal(args.due, tz); if (d) { c.due = d; c.remindedAt = null; } }
      c.updatedAt = Date.now();
      return true;
    });
    if (done) ctx.memoryChanged = true;
    return done ? 'Updated.' : 'No commitment with that id.';
  }
  if (name === 'forget_fact') {
    const done = await editMemory((m) => {
      const i = m.facts.findIndex((f) => f.id === args.id);
      if (i < 0) return false;
      m.facts.splice(i, 1);
      m.deleted[args.id] = Date.now();
      return true;
    });
    if (done) ctx.memoryChanged = true;
    return done ? 'Forgotten.' : 'No fact with that id.';
  }
  if (name === 'run_on_desktop') {
    const ok = ctx.runOnDesktop?.(String(args.request ?? '').slice(0, 4000));
    return ok ? 'Sent to the desktop; it will carry it out and speak there.' : 'The desktop is offline, so this cannot be done right now.';
  }
  return `Unknown tool ${name}.`;
}

// ---------- providers ----------

async function anthropicCall(system, messages) {
  const p = P();
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model, max_tokens: 1024, system, messages,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: t.params, required: t.required } })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function openaiCall(system, messages) {
  const p = P();
  const res = await fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model, max_tokens: 1024, messages: [{ role: 'system', content: system }, ...messages],
      tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.params, required: t.required } } })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Model ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * One request. ctx: { device, kind, voice, desktopOnline, runOnDesktop(text) → bool }.
 * Returns { reply, memoryChanged }.
 */
export async function chat(text, ctx) {
  const p = P();
  if (!p.provider) return { reply: 'My brain isn\'t signed in yet, sir. On the server, run: sudo bash /opt/jarvis/server/jarvis-hub/deploy/login.sh (or add an API key to the .env).', memoryChanged: false };
  const system = await systemPrompt(ctx);
  const history = getHubChat().turns.slice(-12).flatMap((t) => [{ role: 'user', content: t.user }, { role: 'assistant', content: t.reply }]);
  let reply = '';

  if (p.provider === 'claude') {
    reply = await claudeSubscription(system, history, text, ctx);
  } else if (p.provider === 'anthropic') {
    const messages = [...history, { role: 'user', content: text }];
    for (let step = 0; step < 6; step++) {
      const out = await anthropicCall(system, messages);
      messages.push({ role: 'assistant', content: out.content });
      const calls = out.content.filter((b) => b.type === 'tool_use');
      reply = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || reply;
      if (!calls.length || out.stop_reason !== 'tool_use') break;
      const results = [];
      for (const c of calls) results.push({ type: 'tool_result', tool_use_id: c.id, content: await runTool(c.name, c.input ?? {}, ctx) });
      messages.push({ role: 'user', content: results });
    }
  } else {
    const messages = [...history, { role: 'user', content: text }];
    for (let step = 0; step < 6; step++) {
      const out = await openaiCall(system, messages);
      const msg = out.choices?.[0]?.message ?? {};
      messages.push(msg);
      reply = (msg.content ?? '').trim() || reply;
      const calls = msg.tool_calls ?? [];
      if (!calls.length) break;
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
        messages.push({ role: 'tool', tool_call_id: c.id, content: await runTool(c.function?.name, args, ctx) });
      }
    }
  }
  reply ||= 'Done, sir.';
  await addHubTurn({ device: ctx.device, user: text.slice(0, 4000), reply: reply.slice(0, 8000) });
  return { reply, memoryChanged: !!ctx.memoryChanged };
}

// ---------- Claude subscription (Claude Agent SDK, signed in with `claude setup-token`) ----------
// Runs Claude Code headless with none of its own tools: only Jarvis's memory tools, through an in-process MCP server.
let sdk = null;
async function claudeSubscription(system, history, text, ctx) {
  sdk ??= { ...(await import('@anthropic-ai/claude-agent-sdk')), z: (await import('zod')).z };
  const { query, tool, createSdkMcpServer, z } = sdk;
  const shape = (t) => Object.fromEntries(Object.entries(t.params).map(([k, v]) => {
    let s = v.enum ? z.enum(v.enum) : v.type === 'boolean' ? z.boolean() : z.string();
    if (v.description) s = s.describe(v.description);
    return [k, t.required.includes(k) ? s : s.optional()];
  }));
  const server = createSdkMcpServer({
    name: 'jarvis',
    version: '1.0.0',
    tools: TOOLS.map((t) => tool(t.name, t.description, shape(t), async (args) => ({ content: [{ type: 'text', text: await runTool(t.name, args ?? {}, ctx) }] }))),
  });
  const past = history.length ? `\n\nRecent conversation (oldest first):\n${history.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`).join('\n')}` : '';
  const configDir = process.env.CLAUDE_CONFIG_DIR || '/var/lib/jarvis-hub/claude';
  (await import('node:fs')).mkdirSync(configDir, { recursive: true, mode: 0o700 });
  let out = '', last = '';
  for await (const m of query({
    prompt: text,
    options: {
      model: P().model,
      systemPrompt: { type: 'custom', prompt: system + past },
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { jarvis: server },
      allowedTools: TOOLS.map((t) => `mcp__jarvis__${t.name}`),
      permissionMode: 'dontAsk', // anything not listed above is refused
      maxTurns: 6,
      cwd: configDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: '' },
    },
  })) {
    if (m.type === 'assistant') {
      const t = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (t) last = t;
    } else if (m.type === 'result') {
      if (m.subtype === 'success' && typeof m.result === 'string' && m.result.trim()) out = m.result.trim();
      else if (m.is_error) throw new Error(`Claude: ${String(m.result ?? m.subtype).slice(0, 200)}`);
    }
  }
  return out || last;
}
