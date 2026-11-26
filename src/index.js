// yarms-core — the master rule stack, shared by every Yarms client codebase.
//   const { logger, llm, registry, signals, lifecycle } = require('yarms-core');
//
// See ARCHITECTURE.md. Runtime config comes from the consuming app's env
// (USAGE_SUPABASE_*, provider API keys, YARMS_CLIENT); this package holds no secrets.

const logger = require('./usage/logger');
const llm = require('./llm');
const registry = require('./registry');
const signals = require('./signals');
const lifecycle = require('./lifecycle');

module.exports = { logger, llm, registry, signals, lifecycle };
