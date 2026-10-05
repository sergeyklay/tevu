#!/usr/bin/env node
/* global console, process */
// A fake `opencode` answering every capability probe, the models listing (from
// its own written `opencode.json`), and one trivial `run`/`export` pair, so a
// benchmark completes a real case without a real coding agent. Tests derive
// variants by replacing exact lines of this file; keep those lines intact.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('1.0.0-composition-fake');
  process.exit(0);
}
if (args[0] === '--help') {
  console.log('usage: composition-fake <command>');
  process.exit(0);
}
if (args[0] === 'run' && args[1] === '--help') {
  console.log('usage: opencode run --format json --model <model> --variant <variant>');
  process.exit(0);
}
if (args[0] === 'export' && args[1] === '--help') {
  console.log('usage: opencode export <session-id>');
  process.exit(0);
}
if (args[0] === 'models' && args[1] === '--help') {
  console.log('usage: opencode models [provider] --verbose');
  process.exit(0);
}
if (args[0] === 'models') {
  if (args[1] !== '--verbose') {
    process.exit(3);
  }
  const configPath = join(process.env.XDG_CONFIG_HOME ?? '', 'opencode', 'opencode.json');
  let doc = {};
  try {
    doc = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    // No configuration written: the listing is empty.
  }
  const providers = doc && typeof doc === 'object' && doc.provider ? Object.keys(doc.provider) : [];
  for (const id of providers) {
    for (const name of ['synthetic-model-a', 'synthetic-model-b']) {
      console.log(`${id}/${name}`);
      console.log(JSON.stringify({ id: name, variants: { low: {}, high: {} } }, null, 2));
    }
  }
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'config') {
  const permission = process.env.OPENCODE_PERMISSION;
  const document = permission === undefined ? {} : { permission: JSON.parse(permission) };
  console.log(JSON.stringify(document));
  process.exit(0);
}
if (args[0] === 'run') {
  console.log(
    JSON.stringify({
      type: 'step_start',
      timestamp: 1,
      sessionID: 'ses-composition-1',
      part: { id: 'prt-1', sessionID: 'ses-composition-1', messageID: 'msg-1', type: 'step-start' },
    }),
  );
  process.exit(0);
}
if (args[0] === 'export') {
  const requested = args[1] ?? '';
  console.log(JSON.stringify({ info: { id: requested }, messages: [] }));
  process.exit(0);
}
process.exit(3);
