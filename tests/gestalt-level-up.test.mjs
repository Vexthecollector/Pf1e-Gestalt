import assert from "node:assert/strict";
import test from "node:test";
import {
  allowCatchUpFavoredClass,
  getLevelUpSimulacra,
  getLevelUpState,
  isLevelUpReady,
} from "../scripts/gestalt-level-up.mjs";

test("adapts legacy and ApplicationV2 level-up forms", () => {
  const legacyState = { abilityScore: {} };
  const modernState = { abilityScore: {} };
  const legacyActor = { id: "legacy" };
  const modernActor = { id: "modern" };

  assert.equal(getLevelUpState({ config: legacyState }), legacyState);
  assert.equal(getLevelUpState({ levelUp: modernState, config: legacyState }), modernState);
  assert.equal(getLevelUpSimulacra({ simulacra: legacyActor }), legacyActor);
  assert.equal(getLevelUpSimulacra({ _simulacra: modernActor, simulacra: legacyActor }), modernActor);
  assert.equal(isLevelUpReady({ isReady: () => true }), true);
  assert.equal(isLevelUpReady({ isReady: false }), false);
});

test("restores favored-class choices for a favored catch-up class", () => {
  const state = { fcb: { available: false, unavailable: true } };
  const app = { levelUp: state, isFavouredClass: () => true };

  assert.equal(allowCatchUpFavoredClass(app), true);
  assert.deepEqual(state.fcb, { available: true, unavailable: false });
  assert.equal(allowCatchUpFavoredClass(app), false);
});

test("does not enable favored-class choices for a non-favored class", () => {
  const state = { fcb: { available: false, unavailable: true } };
  assert.equal(allowCatchUpFavoredClass({ config: state, isFavouredClass: () => false }), false);
  assert.deepEqual(state.fcb, { available: false, unavailable: true });
});
