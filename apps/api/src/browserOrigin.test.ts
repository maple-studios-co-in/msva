import { expect, it } from "vitest";
import { parseBrowserOrigins } from "./browserOrigin.js";

it("reads each listed origin as its canonical form", () => {
  const { origins, ignored } = parseBrowserOrigins(" HTTPS://Console.Example.Test:443/ , http://localhost:5173, https://bücher.example ");
  expect([...origins]).toEqual(["https://console.example.test", "http://localhost:5173", "https://xn--bcher-kva.example"]);
  expect(ignored).toEqual([]);
});

it("ignores anything that is not a bare http(s) origin", () => {
  const entries = ["https://*.example.test", "https://console.example.test/path", "https://user:pass@console.example.test",
    "https://console.example.test?x=1", "https://console.example.test#top", "ftp://console.example.test", "console.example.test", "null"];
  const { origins, ignored } = parseBrowserOrigins(entries.join(","));
  expect(origins.size).toBe(0);
  expect(ignored).toEqual(entries);
});
