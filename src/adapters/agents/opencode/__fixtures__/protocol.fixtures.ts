import { readFileSync } from 'node:fs';

// The recorded data sits beside this directory, not inside it.
const FIXTURE_DIRECTORY = new URL('../fixtures/', import.meta.url);

/** Reads the recorded OpenCode fixture `name` as text. */
export function readTextFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8');
}

/** Reads the recorded OpenCode fixture `name` as parsed JSON. */
export function readJsonFixture(name: string): unknown {
  return JSON.parse(readTextFixture(name)) as unknown;
}
