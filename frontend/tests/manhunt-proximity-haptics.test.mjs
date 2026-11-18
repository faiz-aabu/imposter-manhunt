import assert from "node:assert/strict";
import test from "node:test";
import { ManhuntProximityHapticGate } from "../src/utils/manhunt-proximity-haptics.ts";

test("proximity haptics cooldown suppresses repeats per threshold", () => {
  const gate = new ManhuntProximityHapticGate();

  assert.equal(gate.shouldTrigger("near", 1_000), true);
  assert.equal(gate.shouldTrigger("near", 2_000), false);
  assert.equal(gate.shouldTrigger("very_near", 2_000), true);
  assert.equal(gate.shouldTrigger("very_near", 3_000), false);
  assert.equal(gate.shouldTrigger("near", 11_000), true);
});

test("proximity haptic cooldown resets when the active map screen resets", () => {
  const gate = new ManhuntProximityHapticGate();

  assert.equal(gate.shouldTrigger("near", 1_000), true);
  gate.reset();
  assert.equal(gate.shouldTrigger("near", 1_001), true);
});
