// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const TRACKERS_DIRECTORY = resolve(import.meta.dirname);
const DOMAIN_DIRECTORY = resolve(TRACKERS_DIRECTORY, "../../domain");

const IMPORT_SPECIFIER_PATTERN = /(?:import|export)(?:[^'"]*?)from\s+["']([^"']+)["']/g;

function trackerModuleFiles(): string[] {
  return readdirSync(TRACKERS_DIRECTORY)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(TRACKERS_DIRECTORY, name));
}

function relativeImportSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.startsWith(".")) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("src/adapters/trackers import boundary", () => {
  it("finds every tracker module to check", () => {
    expect(trackerModuleFiles().length).toBeGreaterThan(0);
  });

  it.each(trackerModuleFiles().map((filePath) => ({ filePath })))(
    "resolves every relative import in $filePath inside src/domain",
    ({ filePath }) => {
      const specifiers = relativeImportSpecifiers(filePath);

      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        const resolved = resolve(dirname(filePath), specifier);
        expect(resolved.startsWith(`${DOMAIN_DIRECTORY}/`)).toBe(true);
      }
    },
  );
});
