// Console mod (SPEC 13). Thin on purpose: it reports events, delivers the console's messages, and exposes tools;
// every decision lives in the console server. Authoring rules verified in Phase 0 (claude plugin validate):
// event names are string literals, hooks are function literals, `$` is only passed to top-level functions,
// $.env.get takes a literal name, and there are no JS timers (use $.clock).
//
// Safety: the mod only acts when it was launched by the console (CONSOLE_URL and CONSOLE_TOKEN set). No hook ever
// throws into the session; a failure is swallowed and the session carries on as if the mod were not there.

let started = false; // the poller and the tools are set up once per process, even if session.start fires again
let ctx = null; // { url, token, role, agent, sid } once session.start has run inside a console session

const POLL_MS = 2000;
const QUESTION_WAIT_SECONDS = 15; // each long-poll stays short; the loop below repeats it (verified: 75 s total works)
const MAX_CONSOLE_FAILURES = 20; // consecutive unreachable-console answers before a waiting tool gives up

/** Calls the console. Never throws: returns { ok, status, json } or { ok: false } when it is unreachable. */
async function call($, method, path, body) {
  if (!ctx) return { ok: false };
  try {
    const headers = { authorization: 'Bearer ' + ctx.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await $.http.fetch(ctx.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = JSON.parse(r.text); } catch (err) { /* empty or non-JSON body */ }
    return { ok: r.ok, status: r.status, json };
  } catch (err) {
    return { ok: false };
  }
}

async function postEvent($, type, data) {
  await call($, 'POST', '/v1/events', { type, sessionId: ctx.sid, data });
}

/** Delivers the console's messages (goals, answers) as new turns; acknowledges before injecting so none repeats. */
function startInboxPoll($) {
  let busy = false;
  $.clock.every(POLL_MS, async () => {
    if (busy || !ctx) return;
    busy = true;
    try {
      const r = await call($, 'GET', '/v1/inbox');
      const messages = r.ok && r.json && Array.isArray(r.json.messages) ? r.json.messages : [];
      for (const m of messages) {
        const acked = await call($, 'POST', '/v1/ack', { id: m.id });
        if (!acked.ok) break; // not confirmed: the console will offer it again, and injecting now would deliver it twice
        await $.prompt.submit({ text: m.text });
      }
    } catch (err) {
      /* the next tick tries again */
    } finally {
      busy = false;
    }
  });
}

const TOOLS_BY_ROLE = {
  main: ['spawn_agent', 'list_agents', 'ask_user'],
  agent: ['list_agents'],
};

const TOOL_SPECS = {
  spawn_agent: {
    description: 'Launch a new agent for one activity. Returns { status: "started" | "queued", position? } or an error code. '
      + 'The name must say what the activity is about (lowercase letters, digits, single dashes), in the working language.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique activity name (slug), for example fix-login-timeout' },
        profile: { type: 'string', description: 'backend, dba, frontend, reviewer or recovery' },
        goal: { type: 'string', description: 'What the agent must achieve: result, constraints, references. Not the steps.' },
        model: { type: 'string', description: 'Optional model alias or id' },
      },
      required: ['name', 'profile', 'goal'],
    },
  },
  list_agents: {
    description: 'List the sessions of this plan: name, profile, state and goal. Use it to know who exists before asking.',
    inputSchema: { type: 'object', properties: {} },
  },
  ask_user: {
    description: 'Put a question to the human in the console queue and wait for the answer. Use it for choices (product, preference, risk); verify facts yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, ending with a question mark' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional 2-4 answers to choose from' },
      },
      required: ['question'],
    },
  },
};

async function registerRoleTools($) {
  for (const name of TOOLS_BY_ROLE[ctx.role] || []) {
    await $.tool.register({ name, description: TOOL_SPECS[name].description, inputSchema: TOOL_SPECS[name].inputSchema });
  }
}

async function onSessionStart($, e, next) {
  try {
    const url = await $.env.get('CONSOLE_URL');
    const token = await $.env.get('CONSOLE_TOKEN');
    if (url && token) {
      ctx = {
        url, token,
        role: (await $.env.get('CONSOLE_ROLE')) || 'agent',
        agent: (await $.env.get('CONSOLE_AGENT')) || '',
        sid: await $.session.id(),
      };
      if (!started) {
        started = true;
        try { await registerRoleTools($); } catch (err) { /* events and the inbox still work without the tools */ }
        startInboxPoll($);
      }
      await postEvent($, 'session.start', { cwd: e.cwd });
    }
  } catch (err) {
    ctx = null;
  }
  return next(e);
}

async function onSimpleEvent($, type, data, e, next) {
  try {
    if (ctx) await postEvent($, type, data);
  } catch (err) { /* never into the session */ }
  return next(e);
}

/** Waits for the human's answer with short long-polls, so no single call is long and nothing hangs forever. */
async function askConsole($, question, options, multiSelect, extra) {
  const created = await call($, 'POST', '/v1/tools/ask_user', { question, options, multiSelect, ...extra });
  if (!created.ok || !created.json || !created.json.id) return { ok: false, reason: 'the console is not reachable' };
  const id = created.json.id;
  let failures = 0;
  for (;;) {
    const r = await call($, 'GET', '/v1/questions/' + id + '?wait=' + QUESTION_WAIT_SECONDS);
    if (r.ok && r.json) {
      failures = 0;
      if (r.json.answered) return { ok: true, answer: String(r.json.answer) };
      if (r.json.gone) return { ok: false, reason: 'the question was withdrawn' };
    } else {
      failures += 1;
      if (failures >= MAX_CONSOLE_FAILURES) return { ok: false, reason: 'the console stopped answering' };
      await $.clock.sleep(1000);
    }
  }
}

async function onConsoleTool($, name, e) {
  try {
    if (!ctx) return { deny: 'This session is not connected to the console.' };
    if (name === 'ask_user') {
      const a = await askConsole($, String(e.question), Array.isArray(e.options) ? e.options.map(String) : undefined, false);
      return { result: a.ok ? 'The user answered: ' + a.answer : 'No answer: ' + a.reason };
    }
    const body = name === 'spawn_agent' ? { name: e.name, profile: e.profile, goal: e.goal, model: e.model } : {};
    const r = await call($, 'POST', '/v1/tools/' + name, body);
    if (!r.json) return { result: 'The console did not answer.' };
    return { result: JSON.stringify(r.json) };
  } catch (err) {
    return { result: 'The console tool failed: ' + String(err) };
  }
}

/** An agent's native AskUserQuestion goes to the console queue instead of a dialog nobody is watching. */
async function onNativeQuestion($, e, next) {
  try {
    if (!ctx || ctx.role !== 'agent' || !Array.isArray(e.questions) || e.questions.length === 0) return next(e);
    const answers = {};
    for (const q of e.questions) {
      const labels = Array.isArray(q.options) ? q.options.map((o) => String(o.label)) : undefined;
      const a = await askConsole($, String(q.question), labels, Boolean(q.multiSelect));
      if (!a.ok) return next(e); // console unreachable: let the normal dialog appear
      answers[q.question] = a.answer;
    }
    return { result: { questions: e.questions, answers } };
  } catch (err) {
    return next(e);
  }
}

/** What a tool call would do, in a line a person can judge: the command, the file, or its arguments. */
function describeInput(input) {
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return input.file_path;
    try { return JSON.stringify(input).slice(0, 2000); } catch (err) { return ''; }
  }
  return '';
}

/**
 * An agent's permission prompt would sit unseen in its terminal. When the engine says "ask", the request goes to the
 * console queue instead and the human's answer becomes the verdict. Anything but an explicit "allow" is a deny; if the
 * console cannot be reached the engine's own dialog stands. The main is left alone: the user is typing in it.
 */
async function onToolCheck($, e, next) {
  const verdict = await next(e);
  try {
    if (!ctx || ctx.role !== 'agent' || !e.tool_use_id || !verdict || verdict.decision !== 'ask') return verdict;
    if (e.tool === 'AskUserQuestion' || String(e.tool).indexOf('mcp__console-mod__') === 0) return verdict;
    const a = await askConsole($, verdict.reason || 'Permission requested', undefined, false,
      { kind: 'permission', tool: String(e.tool), detail: describeInput(e.input) });
    if (!a.ok) return verdict;
    return a.answer === 'allow'
      ? { decision: 'allow', reason: 'Allowed by the user in the console.' }
      : { decision: 'deny', reason: 'The user denied this in the console.' };
  } catch (err) {
    return verdict;
  }
}

export const register = (on) => {
  on('session.start', ($, e, next) => onSessionStart($, e, next));
  on('session.end', ($, e, next) => onSimpleEvent($, 'session.end', {}, e, next));
  on('turn.start', ($, e, next) => onSimpleEvent($, 'turn.start', {}, e, next));
  on('turn.complete', ($, e, next) => onSimpleEvent($, 'turn.complete',
    { turn: e.turnId, answer: e.answer, isAborted: e.isAborted, durationMs: e.durationMs }, e, next));

  on('tool.call', { tool: 'mcp__console-mod__spawn_agent' }, ($, e) => onConsoleTool($, 'spawn_agent', e));
  on('tool.call', { tool: 'mcp__console-mod__list_agents' }, ($, e) => onConsoleTool($, 'list_agents', e));
  on('tool.call', { tool: 'mcp__console-mod__ask_user' }, ($, e) => onConsoleTool($, 'ask_user', e));
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => onNativeQuestion($, e, next));
  on('tool.check', ($, e, next) => onToolCheck($, e, next));
};
