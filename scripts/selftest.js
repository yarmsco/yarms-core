// Proves yarms-core loads and its core paths work. Hermetic by default; the live
// generate() runs only with a key:  doppler run --project yarms_co_portal --config prd -- node scripts/selftest.js
const { logger, llm, registry, signals } = require('..');

(async () => {
  let ok = true;
  const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && cond; };

  check('exports logger/llm/registry/signals', !!(logger && llm && registry && signals));

  // usage across every step, not just the last (web search / tool loops)
  const step = (i, o, cr, cw, cw1h, ws) => ({ providerMetadata: { anthropic: { usage: {
    input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
    cache_creation: { ephemeral_1h_input_tokens: cw1h }, server_tool_use: { web_search_requests: ws } } } } });
  const u = llm.usageOf({ steps: [step(100, 10, 5, 7, 2, 1), step(200, 20, 0, 0, 0, 2)] });
  check('usageOf sums all steps', u.input_tokens === 300 && u.output_tokens === 30 && u.cache_read_input_tokens === 5
    && u.cache_creation_input_tokens === 7 && u.cache_creation.ephemeral_1h_input_tokens === 2 && u.server_tool_use.web_search_requests === 3);
  const g = llm.usageOf({ totalUsage: { inputTokens: 50, outputTokens: 5, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 10 } } });
  check('usageOf falls back to totalUsage (non-Anthropic)', g.input_tokens === 40 && g.cache_read_input_tokens === 10);

  // overlapping runs never see each other's calls
  const rows = [];
  const writeRows = async (r) => { rows.push(...r); };
  const a = logger.startRun({ client: 'A', agent: 'x', label: 'a' }, { writeRows });
  const b = logger.startRun({ client: 'B', agent: 'y', label: 'b' }, { writeRows });
  const usage = { input_tokens: 10, output_tokens: 1 };
  await Promise.all([
    a.scope(async () => { await new Promise((r) => setTimeout(r, 20)); await logger.record({ model: 'm', usage, callType: 'a1' }); }),
    b.scope(async () => { await logger.record({ model: 'm', usage, callType: 'b1' }); await b.finish();
                          await logger.record({ model: 'm', usage, callType: 'b-late' }); }),
  ]);
  await a.finish();
  const calls = (c) => rows.filter((r) => r.level === 'call' && r.client === c).map((r) => r.callType);
  check('run A keeps its call while B overlaps', JSON.stringify(calls('A')) === '["a1"]');
  check('a call after finish() is still written', calls('B').includes('b-late'));
  check('run rows carry their own call count', rows.find((r) => r.level === 'run' && r.client === 'A').claudeCalls === 1);

  // facts, not prices: no cost is written by the logger
  const row = logger._toRow({ level: 'call', client: 'A', agent: 'x', model: 'm', ...logger.factsFromUsage({
    input_tokens: 1, cache_creation_input_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 3 }, server_tool_use: { web_search_requests: 2 } }) });
  check('row records 1h cache writes + web searches, no cost', row.cache_write_tokens === 4 && row.cache_write_1h_tokens === 3
    && row.web_search_requests === 2 && !('cost_usd' in row));

  let threw = false; try { logger.setRunContext({}); } catch (_) { threw = true; }
  check('removed global API fails loudly', threw);

  check('providerOf(gemini-*) = google', llm.providerOf('gemini-2.5-flash') === 'google');
  check('providerOf(claude-*) = anthropic', llm.providerOf('claude-haiku-4-5') === 'anthropic');
  const m = await registry.resolveModel('yarms_core.selftest', 'claude-haiku-4-5');
  check('resolveModel falls back to caller model', m === 'claude-haiku-4-5');

  if (process.env.ANTHROPIC_API_KEY) {
    const out = await logger.withRun({ client: 'yarms_core', agent: 'selftest', label: 'selftest' }, () => llm.generate({
      taskKey: 'yarms_core.selftest', model: 'claude-haiku-4-5',
      system: 'Reply with exactly one word.', prompt: 'Say "ok".', webSearch: false, maxOutputTokens: 20,
    }));
    check('generate() returned text + served model', !!out.text && /^claude-haiku-4-5/.test(out.model));
    console.log('   →', JSON.stringify(out.text), '| tokens', out.inputTokens, '/', out.outputTokens);
  } else {
    console.log('SKIP  live generate() — no ANTHROPIC_API_KEY in env');
  }

  console.log(ok ? '\nRESULT: PASS ✅' : '\nRESULT: FAIL ❌');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
