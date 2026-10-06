import { describe, expect, it } from "vitest";
import { parseAssetsCsv, parseCsv } from "./csv";
import { splitAssetId } from "./device";

describe("parseCsv", () => {
  it("reads quoted cells with commas, quotes and line breaks", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"l1\nl2",z')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["l1\nl2", "z"],
    ]);
  });

  it("detects semicolon separators and ignores BOM and blank lines", () => {
    expect(parseCsv("﻿a;b\r\n1;2\r\n\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseAssetsCsv", () => {
  it("finds columns by name in any order and counts invalid rows", () => {
    const csv = "serial,asset_short_id\nSCQ9N6HRVF4,MacBook Neo 13 256GB-0086\n,iPhone 14 128GB-2386\nSY7Q0TN43VF,\n";
    expect(parseAssetsCsv(csv)).toEqual({
      rows: [{ asset_short_id: "MacBook Neo 13 256GB-0086", serial: "SCQ9N6HRVF4" }],
      invalid: 2,
    });
  });

  it("keeps hyphens and inch marks inside the asset id", () => {
    const csv = 'asset_short_id,serial\n"Monitor Portátil Acer 15.6""-0084",MMTWBAA002502000E83S0A\n';
    expect(parseAssetsCsv(csv).rows[0]?.asset_short_id).toBe('Monitor Portátil Acer 15.6"-0084');
  });

  it("reports a missing header", () => {
    expect(parseAssetsCsv("a,b\n1,2").error).toBeDefined();
  });
});

describe("splitAssetId", () => {
  it("splits model and unit id at the last hyphen", () => {
    expect(splitAssetId("iPhone 14 128GB-2386")).toEqual({ model: "iPhone 14 128GB", code: "2386" });
    expect(splitAssetId("Chromebook Acer Touch C734T-C23A-0029")).toEqual({
      model: "Chromebook Acer Touch C734T-C23A",
      code: "0029",
    });
    expect(splitAssetId("iPhone 17 Pro Max 256GB-WITI").code).toBe("WITI");
  });

  it("returns the whole text as model when there is no hyphen", () => {
    expect(splitAssetId("Sem hifen")).toEqual({ model: "Sem hifen", code: "" });
  });
});
