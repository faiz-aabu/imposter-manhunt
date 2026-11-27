import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowFirstLaunchTutorial } from "../src/utils/tutorial.ts";

test("first launch shows the tutorial when no completion or room session exists", () => {
  assert.equal(shouldShowFirstLaunchTutorial(false, false, false), true);
});

test("completed tutorials and saved or active room sessions are not interrupted", () => {
  assert.equal(shouldShowFirstLaunchTutorial(true, false, false), false);
  assert.equal(shouldShowFirstLaunchTutorial(false, true, false), false);
  assert.equal(shouldShowFirstLaunchTutorial(false, false, true), false);
});
