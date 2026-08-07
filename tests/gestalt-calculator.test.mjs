import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateGestaltLevelProgression,
  isFixedClass,
  selectGestaltLevelHealth,
} from "../scripts/gestalt-calculator.mjs";

test("detects fixed classes from live-item and plain-object shapes", () => {
  assert.equal(isFixedClass({ subType: "racial" }), true);
  assert.equal(isFixedClass({ system: { subType: "mythic" } }), true);
  assert.equal(isFixedClass({ subType: "base", system: { subType: "racial" } }), false);
  assert.equal(isFixedClass({ system: { subType: "base" } }), false);
});

test("chooses BAB and saves independently at every stored gestalt level", () => {
  const items = new Map([
    ["fighter", { id: "fighter" }],
    ["wizard", { id: "wizard" }],
    ["rogue", { id: "rogue" }],
    ["cleric", { id: "cleric" }],
  ]);
  const gains = {
    fighter: [{ bab: 1, fort: 2, ref: 0, will: 0 }, { bab: 1, fort: 1, ref: 0, will: 0 }],
    wizard: [{ bab: 0, fort: 0, ref: 0, will: 2 }, { bab: 1, fort: 0, ref: 0, will: 1 }],
    rogue: [{ bab: 0, fort: 0, ref: 2, will: 0 }],
    cleric: [{ bab: 0, fort: 2, ref: 0, will: 2 }],
  };
  const result = calculateGestaltLevelProgression(
    [
      { mainClassId: "fighter", secondaryClassId: "wizard" },
      { mainClassId: "rogue", secondaryClassId: "cleric" },
      { mainClassId: "fighter", secondaryClassId: "wizard" },
    ],
    {
      getItem: (id) => items.get(id),
      getStats: (item, level) => ({ hitDice: 1, ...gains[item.id][level - 1] }),
    },
  );
  assert.deepEqual(result, {
    level: 3,
    hitDice: 3,
    bab: 2,
    saves: { fort: 3, ref: 2, will: 5 },
    rows: [
      { bab: 1, fort: 2, ref: 0, will: 2 },
      { bab: 0, fort: 0, ref: 2, will: 2 },
      { bab: 1, fort: 1, ref: 0, will: 1 },
    ],
  });
});

test("does not cherry-pick alternating good and poor save increments", () => {
  const items = new Map([
    ["druid", { id: "druid" }],
    ["monk", { id: "monk" }],
  ]);
  const good = [2, 1, 0];
  const poor = [0, 0, 1];
  const result = calculateGestaltLevelProgression(
    Array.from({ length: 3 }, () => ({ mainClassId: "druid", secondaryClassId: "monk" })),
    {
      getItem: (id) => items.get(id),
      getStats: (item, level) => ({
        hitDice: 1,
        bab: 0,
        fort: good[level - 1],
        ref: item.id === "monk" ? good[level - 1] : poor[level - 1],
        will: item.id === "druid" ? good[level - 1] : poor[level - 1],
      }),
    },
  );
  assert.deepEqual(result.saves, { fort: 3, ref: 3, will: 3 });
  assert.deepEqual(result.rows.map((row) => row.ref), [2, 1, 0]);
  assert.deepEqual(result.rows.map((row) => row.will), [2, 1, 0]);
});

test("an empty track contributes zero hit dice", () => {
  const item = { id: "template" };
  const result = calculateGestaltLevelProgression(
    [{ mainClassId: "template", secondaryClassId: null }],
    {
      getItem: (id) => id === item.id ? item : null,
      getStats: () => ({ hitDice: 0, bab: 0, fort: 0, ref: 0, will: 0 }),
    },
  );
  assert.equal(result.hitDice, 0);
  assert.deepEqual(result.rows, [{ bab: 0, fort: 0, ref: 0, will: 0 }]);
});

test("a maximized opportunity is consumed even when manual HP wins the level", () => {
  assert.deepEqual(
    selectGestaltLevelHealth(
      { value: 6, maximized: true },
      { value: 8, maximized: false },
    ),
    { value: 8, consumesMaximized: true },
  );
});
