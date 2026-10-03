import assert from "node:assert/strict";
import test from "node:test";
import { isValidCoordinatorSecret } from "../src/services/p2pSecurity";

test("coordinator secret must be present and exactly match", () => {
  assert.equal(isValidCoordinatorSecret(undefined, "secret"), false);
  assert.equal(isValidCoordinatorSecret("", "secret"), false);
  assert.equal(isValidCoordinatorSecret("SECRET", "secret"), false);
  assert.equal(isValidCoordinatorSecret("wrong", "secret"), false);
  assert.equal(isValidCoordinatorSecret("secret", "secret"), true);
});

test("misconfigured coordinator secret is always rejected", () => {
  assert.equal(
    isValidCoordinatorSecret("MisconfiguredMatchUpdateKey", "MisconfiguredMatchUpdateKey"),
    false,
  );
});
