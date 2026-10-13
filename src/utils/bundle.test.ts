import { describe, expect, it } from "vitest";
import { bundlePath } from "./bundle";

describe("bundlePath", () => {
  it("reads the main script of a built index.html", () => {
    const html = `<head><script type="module" crossorigin src="/assets/index-Clt2s-uh.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-6gAWbRss.css"></head>`;
    expect(bundlePath(html)).toBe("/assets/index-Clt2s-uh.js");
  });

  it("changes when a new version is published", () => {
    const before = bundlePath('<script type="module" src="/assets/index-AAA.js"></script>');
    const after = bundlePath('<script type="module" src="/assets/index-BBB.js"></script>');
    expect(before).not.toBe(after);
  });

  it("is null when there is no built script, as in development", () => {
    expect(bundlePath('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(bundlePath("<html></html>")).toBeNull();
  });
});
