// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, parseConfigText } from "./load.ts";
import { TevuConfigSchema } from "./schema.ts";
import { CONFIG_TEMPLATE } from "./template.ts";

const OPTIONAL_LINE_PATTERN = /^( *)# ( *(?:- )?[A-Za-z][A-Za-z0-9_]*:(?: |$))/;

/**
 * Enables every commented-out optional field in a template. Explanatory comments
 * sit on their own lines too, so only a comment that reads as a YAML key or list
 * item loses its leading `# `.
 */
function uncomment(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(OPTIONAL_LINE_PATTERN, "$1$2"))
    .join("\n");
}

/** Re-parses a value the schema already accepted; the output must remain valid input. */
function reparse(config: unknown): unknown {
  const result = TevuConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`expected the materialized configuration to re-parse: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}

describe("CONFIG_TEMPLATE", () => {
  it("contains only printable ASCII and LF, with no trailing space and exactly one final LF", () => {
    for (const character of CONFIG_TEMPLATE) {
      const codePoint = character.codePointAt(0) ?? 0;
      expect(character === "\n" || (codePoint >= 0x20 && codePoint <= 0x7e)).toBe(true);
    }
    expect(CONFIG_TEMPLATE).not.toContain("\r");
    expect(CONFIG_TEMPLATE).not.toContain("\t");
    for (const line of CONFIG_TEMPLATE.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
    expect(CONFIG_TEMPLATE.endsWith("\n")).toBe(true);
    expect(CONFIG_TEMPLATE.endsWith("\n\n")).toBe(false);
  });

  it("enables exactly fifteen commented-out key lines", () => {
    const enabledCount = CONFIG_TEMPLATE.split("\n").filter((line) => OPTIONAL_LINE_PATTERN.test(line)).length;

    expect(enabledCount).toBe(15);
  });

  it.each([
    { description: "as written", text: CONFIG_TEMPLATE },
    { description: "with every optional line enabled", text: uncomment(CONFIG_TEMPLATE) },
  ])("re-parses a parsed template $description to a deeply equal value", ({ text }) => {
    const parsedOnce = parseConfigText(text);
    if (!parsedOnce.ok) {
      throw new Error(`expected the template to parse: ${JSON.stringify(parsedOnce.error)}`);
    }

    const parsedTwice = reparse(parsedOnce.value);

    expect(parsedTwice).toEqual(parsedOnce.value);
  });

  describe("loadConfig", () => {
    let tempDirectory: string;

    beforeEach(async () => {
      tempDirectory = await fs.mkdtemp(join(tmpdir(), "tevu-config-template-"));
    });

    afterEach(async () => {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    });

    async function writeConfigFile(content: string): Promise<string> {
      const filePath = join(tempDirectory, "tevu.yaml");
      await fs.writeFile(filePath, content, "utf8");
      return filePath;
    }

    it("is accepted as written", async () => {
      const configPath = await writeConfigFile(CONFIG_TEMPLATE);

      const result = await loadConfig(configPath);

      expect(result.ok).toBe(true);
    });

    it("is accepted with every optional field enabled", async () => {
      const configPath = await writeConfigFile(uncomment(CONFIG_TEMPLATE));

      const result = await loadConfig(configPath);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.trackers?.jira).not.toBeUndefined();
      const task = result.value.tasks[0];
      expect(task?.source).toMatchObject({ kind: "jira", key: "PROJ-123" });
      const checkIds = [...(task?.checks.acceptance ?? []), ...(task?.checks.done ?? [])].map(
        (check) => check.id,
      );
      expect(checkIds).toContain("csv-content");
      expect(checkIds).toContain("tests");
    });
  });
});
