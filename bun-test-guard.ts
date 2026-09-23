// process.stderr.write, not console.error: under this preload, console.error
// is attributed to the first queued test file and breaks the byte contract.
process.stderr.write('error: this project runs tests with Vitest on Node; use `bun run test`\n');
process.exit(1);
