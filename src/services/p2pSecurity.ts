import { timingSafeEqual } from "crypto";

/** Compare coordinator secrets without accepting missing/misconfigured values. */
export function isValidCoordinatorSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate || !expected || expected === "MisconfiguredMatchUpdateKey") return false;

  const actualBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
