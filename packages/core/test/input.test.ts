import { describe, it, expect } from "vitest";
import { parseZpcr, zpcrFromFile, zpcrFromBlob } from "../src/index.js";
import { readSampleBytes, SAMPLE_PATH } from "./sample.js";

describe("isomorphic input handling", () => {
  it("accepts a Uint8Array", () => {
    const zpcr = parseZpcr(readSampleBytes());
    expect(zpcr.reads).toHaveLength(45);
  });

  it("accepts an ArrayBuffer", () => {
    const bytes = readSampleBytes();
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const zpcr = parseZpcr(ab);
    expect(zpcr.reads).toHaveLength(45);
  });

  it("reads from disk via the Node helper", async () => {
    const zpcr = await zpcrFromFile(SAMPLE_PATH);
    expect(zpcr.metadata.baseSerialNumber).toBe("CT019138");
  });

  it("reads from a Blob via the browser-style helper", async () => {
    const blob = new Blob([readSampleBytes()]);
    const zpcr = await zpcrFromBlob(blob);
    expect(zpcr.reads).toHaveLength(45);
  });

  it("throws a clear error on a non-zpcr buffer", () => {
    expect(() => parseZpcr(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});
