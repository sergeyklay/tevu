import { describe, expect, it } from "vitest";

import { describeCause } from "./describe-cause.ts";

describe("describeCause", () => {
  it("returns the message of an Error with a string message", () => {
    const cause = new Error("disk is full");

    expect(describeCause(cause)).toBe("disk is full");
  });

  it("returns the string form of a non-Error primitive", () => {
    expect(describeCause("boom")).toBe("boom");
  });

  it("returns the string form of an Error whose message is not a string", () => {
    const cause = new Error();
    Object.defineProperty(cause, "message", { value: 42 });

    expect(describeCause(cause)).toBe("42");
  });

  it("returns the fallback text when the message getter throws", () => {
    const cause = new Error();
    Object.defineProperty(cause, "message", {
      get() {
        throw new Error("message getter exploded");
      },
    });

    expect(describeCause(cause)).toBe("thrown value cannot be converted to text");
  });

  it("returns the fallback text for a value String cannot convert", () => {
    expect(describeCause(Object.create(null))).toBe("thrown value cannot be converted to text");
  });
});
