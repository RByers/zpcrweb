import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/duration.js";

describe("formatDuration", () => {
  it("writes a hold as clock time rather than a count of seconds", () => {
    expect(formatDuration(2700)).toBe("45:00");
    expect(formatDuration(60)).toBe("1:00");
    expect(formatDuration(90)).toBe("1:30");
  });

  it("keeps the leading 0: for a sub-minute time, so it reads as a time", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(0)).toBe("0:00");
  });

  it("grows an hours field once it needs one, or when forced for an axis", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3925)).toBe("1:05:25");
    expect(formatDuration(90, { hours: true })).toBe("0:01:30");
  });

  it("rounds to whole seconds and signs a negative with a true minus", () => {
    expect(formatDuration(89.6)).toBe("1:30");
    expect(formatDuration(-5)).toBe("−0:05");
  });

  it("says ? for a malformed operand instead of NaN", () => {
    expect(formatDuration(NaN)).toBe("?");
    expect(formatDuration(Infinity)).toBe("?");
  });
});
