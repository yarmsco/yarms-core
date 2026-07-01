// Proves yarms-core loads and its core paths work. Run with a client's env for the
// live pieces:  doppler run --project yarms_co_portal --config prd -- node scripts/selftest.js
const { logger, llm, registry, signals } = require('..');

(async () => {
  let ok = true;
  const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && cond; };

  // exports
  check('exports logger/llm/registry/signals', !!(logger && llm && registry && signals));

  // pricing/cost math
  const c = logger.cost('claude-sonnet-4-6', 1_000_000, 1_000_000);
  check('cost() = in+out ($3 + $15 = $18)', c === 18);

  // provider routing
  check('providerOf(gemini-*) = google', llm.providerOf('gemini-2.5-flash') === 'google');
  check('providerOf(claude-*) = anthropic', llm.providerOf('claude-haiku-4-5') === 'anthropic');

  // registry resolve falls back gracefully (returns the fallback when no override/table)
  const m = await registry.resolveModel('yarms_core.selftest', 'claude-haiku-4-5');
  check('resolveModel falls back to caller model', m === 'claude-haiku-4-5');

  // live generate through the layer (cheap, model resolved via registry→fallback)
  if (process.env.ANTHROPIC_API_KEY) {
    const out = await llm.generate({
      taskKey: 'yarms_core.selftest', model: 'claude-haiku-4-5',
      system: 'Reply with exactly one word.', prompt: 'Say "ok".',
      webSearch: false, maxOutputTokens: 20,
    });
    check('generate() returned text + effective model', !!out.text && out.model === 'claude-haiku-4-5');
    console.log('   →', JSON.stringify(out.text), '| tokens', out.inputTokens, '/', out.outputTokens);
  } else {
    console.log('SKIP  live generate() — no ANTHROPIC_API_KEY in env');
  }

  console.log(ok ? '\nRESULT: PASS ✅' : '\nRESULT: FAIL ❌');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
