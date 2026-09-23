// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { loadConfig } from "./load.ts";
import { TevuConfigSchema } from "./schema.ts";
import { CONFIG_TEMPLATE } from "./template.ts";

/**
 * Enables every commented-out optional field in a template. Explanatory comments
 * sit on their own lines too, so only a comment that reads as a YAML key or list
 * item loses its leading `# `.
 */
function uncomment(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^( *)# ( *(?:- )?[A-Za-z][A-Za-z0-9]*:(?: |$))/, "$1$2"))
    .join("\n");
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
      expect(result.value.jira).not.toBeUndefined();
      const task = result.value.tasks[0];
      expect(task.source).toMatchObject({ reference: "PROJ-123" });
      const checkIds = [...task.acceptanceCriteria, ...task.definitionOfDone].map(
        (check) => check.id,
      );
      expect(checkIds).toContain("csv-content");
      expect(checkIds).toContain("tests");
    });
  });

  it.each([
    ["the active template", CONFIG_TEMPLATE],
    ["the uncommented template", uncomment(CONFIG_TEMPLATE)],
  ])("matches TevuConfigSchema key order and explicit values for %s", (_label, text) => {
    const parsed = parseDocument(text, { version: "1.2", schema: "core" }).toJS();

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(TevuConfigSchema.parse(parsed)));
  });
});
