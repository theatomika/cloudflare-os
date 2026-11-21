import { expect, it } from "vitest";
import configurator from "../src/configurator/acme-configurator-ui";
import { itemUrl, parseResourceUrl } from "../src/acme-urls";

// The configurator frame is compiled alone, so it holds a copy of the link grammar in
// src/acme-urls.ts. This keeps the copies in step: what the frame builds is what the server parses.
it("builds the link the server parses", () => {
  const url = configurator.resourceUrl({ values: { itemUrl: `${itemUrl("abc-123")}/history` }, ui: undefined as never });
  expect(url).toBe(itemUrl("abc-123"));
  expect(parseResourceUrl(url)).toEqual({ itemId: "abc-123" });
});
