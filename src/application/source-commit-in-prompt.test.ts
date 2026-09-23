import { describe, expect, it } from "vitest";

import { describeSourceCommitInPrompt } from "./source-commit-in-prompt.ts";

const SOURCE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

describe("describeSourceCommitInPrompt", () => {
  it.each([
    { label: "the lowercase prefix", prompt: "text abcdef0 more text" },
    { label: "the uppercase prefix", prompt: "text ABCDEF0 more text" },
    { label: "a longer mixed-case prefix", prompt: "text AbCdEf012345 more text" },
    { label: "the full SHA", prompt: `text ${SOURCE_COMMIT} more text` },
  ])("returns the reason when the prompt contains $label", ({ prompt }) => {
    expect(describeSourceCommitInPrompt(prompt, SOURCE_COMMIT)).toBe(
      "agent prompt contains resolved start commit abcdef0",
    );
  });

  it.each([
    { label: "the first 6 characters only", prompt: "text abcdef more text" },
    { label: "characters 2 to 8 only", prompt: "text bcdef01 more text" },
    { label: "an unrelated 40-character SHA", prompt: "text fedcba9876543210fedcba9876543210fedcba98 more text" },
    { label: "the hex word deadbeef", prompt: "text deadbeef more text" },
  ])("returns undefined when the prompt contains only $label", ({ prompt }) => {
    expect(describeSourceCommitInPrompt(prompt, SOURCE_COMMIT)).toBeUndefined();
  });
});
