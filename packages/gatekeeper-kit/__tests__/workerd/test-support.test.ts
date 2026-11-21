import { expect, it } from "vitest";
import { CredentialCoordinator } from "../../src/credentials";
import { failure, outcome, seedCredentials, unwrap } from "../../src/test-support";
import { fakeKv } from "../fake-kv";

it("seeds credentials that a coordinator serves as a connect flow's", async () => {
  const kv = fakeKv();
  seedCredentials(kv, { accessToken: "token" });

  const coordinator = new CredentialCoordinator<{ accessToken: string }>(kv);
  const { creds, identity, generation } = await coordinator.snapshot(async current => current);
  expect(creds).toEqual({ accessToken: "token" });
  // The fences a connected account's reads are adjudicated against.
  expect(identity).toBe(coordinator.identity());
  expect(identity).not.toBe("");
  expect(generation).toBe(coordinator.connectionGeneration());

  // A connect, not a write of the record: seeding again is a new connection.
  seedCredentials(kv, { accessToken: "second" });
  expect(coordinator.connectionGeneration()).not.toBe(generation);
});

it("carries a call's result, or its failure's message, as plain data", async () => {
  const done = await outcome(async () => 1);
  const failed = await outcome(async () => { throw new Error("refused"); });
  expect([done, failed]).toEqual([{ ok: 1 }, { error: "refused" }]);
  expect([unwrap(done), failure(failed)]).toEqual([1, "refused"]);
  expect(() => unwrap(failed)).toThrow("refused");
  expect(() => failure(done)).toThrow("Expected a failure, got 1");
});
