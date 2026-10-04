import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');

await rm(join(root, 'dist'), { recursive: true, force: true });

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

if (typeof manifest.version !== 'string' || manifest.version === '') {
  process.stderr.write('error: package.json "version" must be a non-empty string\n');
  process.exitCode = 1;
} else {
  await build({
    entryPoints: [join(root, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'external',
    outfile: join(root, 'dist', 'index.js'),
    define: { __TEVU_VERSION__: JSON.stringify(manifest.version) },
    logLevel: 'info',
  });
}
