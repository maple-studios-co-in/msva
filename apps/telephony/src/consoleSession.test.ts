import { expect, it } from "vitest";
import { parseBrowserOrigins as apiParse } from "../../api/src/browserOrigin.js";
import { parseBrowserOrigins } from "./consoleSession.js";

it("reads BROWSER_ORIGINS exactly as the API does", () => {
  const values = [
    undefined, "", " , ", "https://console.example.test", "HTTPS://Console.Example.Test:443/, http://localhost:5173",
    "https://*.example.test", "https://console.example.test/path, https://user@console.example.test", "https://bücher.example",
    "http://[::1]:5173, https://console.example.test:8443", "null, ftp://x.example, console.example.test"
  ];
  for (const value of values) expect(parseBrowserOrigins(value)).toEqual(apiParse(value));
});
