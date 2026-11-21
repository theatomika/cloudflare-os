// What a read returns and reports, through a binding's session as a gadget holds it.

import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { unwrap } from "@gadgets/gatekeeper-kit/test-support";
import { itemSubresourceId } from "../../src/acme-resources";
import { itemUrl } from "../../src/acme-urls";
import { connected, fakeAcme } from "./fake-acme";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reads the binding's item as the connected user, and reports it", async () => {
  const requests = fakeAcme([{ id: "item1", title: "First", updated_at: "2026-01-01T00:00:00Z" }]);
  const host = env.TEST_HOST.get(env.TEST_HOST.idFromName("host"));
  const props = { userObjectId: await connected(), itemId: "item1" };
  // A facet keeps its storage, so each scenario names a new one.
  const facet = crypto.randomUUID();

  expect(unwrap(await host.run(facet, props, [["get"]])))
    .toEqual({ id: "item1", title: "First", updatedAt: "2026-01-01T00:00:00Z", url: itemUrl("item1") });
  expect((await host.queueLog(facet)).observations.map(({ subresources }) => subresources))
    .toEqual([[itemSubresourceId("item1")]]);
  expect(requests).toEqual(["GET /items/item1"]);
});
