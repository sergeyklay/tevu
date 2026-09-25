// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const AGENTS_DIRECTORY = resolve(import.meta.dirname);
const DOMAIN_DIRECTORY = resolve(AGENTS_DIRECTORY, "../../domain");

const RELATIVE_IMPORT_PATTERN = /(?:import|export)(?:[^'"]*?)from\s+["']([^"']+)["']/g;
const BARE_IMPORT_PATTERN = /^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

const FORBIDDEN_SPECIFIERS = new Set(["execa", "child_process", "node:child_process"]);

function walkAgentModuleFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const filePath = join(directory, name);
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      files.push(...walkAgentModuleFiles(filePath));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      files.push(filePath);
    }
  }
  return files;
}

function agentModuleFiles(): string[] {
  return walkAgentModuleFiles(AGENTS_DIRECTORY);
}

/** Every specifier of an `import ... from`, `export ... from`, a bare `import "..."`, or `import("...")`. */
function everySpecifier(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const pattern of [RELATIVE_IMPORT_PATTERN, BARE_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/** The directory a module's own relative specifiers may resolve inside, besides `src/domain/`. */
function ownAgentDirectory(filePath: string): string | null {
  const relativeToAgents = relative(AGENTS_DIRECTORY, dirname(filePath));
  const [ownName] = relativeToAgents.split(/[/\\]/);
  return ownName === undefined || ownName === "" ? null : join(AGENTS_DIRECTORY, ownName);
}

describe("src/adapters/agents import boundary", () => {
  it("finds every agent module to check", () => {
    expect(agentModuleFiles().length).toBeGreaterThan(0);
  });

  it.each(agentModuleFiles().map((filePath) => ({ filePath })))(
    "resolves every relative import in $filePath inside src/domain or its own agent directory, and never imports a process-launching module",
    ({ filePath }) => {
      const specifiers = everySpecifier(filePath);
      const ownDirectory = ownAgentDirectory(filePath);

      for (const specifier of specifiers) {
        expect(FORBIDDEN_SPECIFIERS.has(specifier)).toBe(false);
        if (!specifier.startsWith(".")) {
          continue;
        }
        const resolved = resolve(dirname(filePath), specifier);
        const insideDomain = resolved.startsWith(`${DOMAIN_DIRECTORY}/`) || resolved === DOMAIN_DIRECTORY;
        const insideOwnDirectory =
          ownDirectory !== null && (resolved.startsWith(`${ownDirectory}/`) || resolved === ownDirectory);
        expect(insideDomain || insideOwnDirectory).toBe(true);
      }
    },
  );
});
