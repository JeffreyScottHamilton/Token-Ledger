#!/usr/bin/env node
// Claude Token Ledger CLI entry. Installs a warning filter BEFORE node:sqlite is loaded (lazily, via cli.mjs)
// so the SQLite ExperimentalWarning never reaches stderr.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning' && /sqlite/i.test(String(w.message))) return;
  process.stderr.write(`${w && w.name ? w.name : 'Warning'}: ${w && w.message ? w.message : String(w)}\n`);
});

const { main } = await import('../lib/cli.mjs');
const code = await main(process.argv.slice(2));
process.exitCode = code;
