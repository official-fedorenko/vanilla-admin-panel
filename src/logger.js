/**
 * Minimal structured-ish logger: timestamp + level prefix on every line.
 * Not a replacement for a real logging library — just makes server output
 * greppable/parseable instead of bare console.log calls scattered around.
 */

function timestamp() {
  return new Date().toISOString();
}

function info(...args) {
  console.log(`[${timestamp()}] [INFO]`, ...args);
}

function warn(...args) {
  console.warn(`[${timestamp()}] [WARN]`, ...args);
}

function error(...args) {
  console.error(`[${timestamp()}] [ERROR]`, ...args);
}

module.exports = { info, warn, error };
