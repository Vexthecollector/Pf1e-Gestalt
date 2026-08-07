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
    saves: { fort: 5, ref: 2, will: 5 },
    rows: [
      { bab: 1, fort: 2, ref: 0, will: 2 },
      { bab: 0, fort: 2, ref: 2, will: 2 },
      { bab: 1, fort: 1, ref: 0, will: 1 },
    ],
  });
});

test("retains a later class's better save gains on either track", () => {
  const items = new Map([
    ["main-fort", { id: "main-fort" }],
    ["secondary-ref-will", { id: "secondary-ref-will" }],
    ["main-ref", { id: "main-ref" }],
    ["secondary-will", { id: "secondary-will" }],
  ]);
  const good = [2, 1, 0, 1, 0];
  const poor = [0, 0, 1, 0, 0];
  const progressions = {
    "main-fort": { fort: good, ref: poor, will: poor },
    "secondary-ref-will": { fort: poor, ref: good, will: good },
    "main-ref": { fort: poor, ref: good, will: poor },
    "secondary-will": { fort: poor, ref: poor, will: good },
  };
  const levels = [
    ...Array.from({ length: 5 }, () => ({
      mainClassId: "main-fort",
      secondaryClassId: "secondary-ref-will",
    })),
    ...Array.from({ length: 3 }, () => ({
      mainClassId: "main-ref",
      secondaryClassId: "secondary-will",
    })),
  ];

  const result = calculateGestaltLevelProgression(levels, {
    getItem: (id) => items.get(id),
    getStats: (item, level) => ({
      hitDice: 1,
      bab: 0,
      babRank: 1,
      fort: progressions[item.id].fort[level - 1],
      fortRank: item.id === "main-fort" ? 2 : 1,
      ref: progressions[item.id].ref[level - 1],
      refRank: ["secondary-ref-will", "main-ref"].includes(item.id) ? 2 : 1,
      will: progressions[item.id].will[level - 1],
      willRank: ["secondary-ref-will", "secondary-will"].includes(item.id) ? 2 : 1,
    }),
  });

  assert.deepEqual(result.saves, { fort: 5, ref: 7, will: 7 });
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
        babRank: 1,
        fort: good[level - 1],
        fortRank: 2,
        ref: item.id === "monk" ? good[level - 1] : poor[level - 1],
        refRank: item.id === "monk" ? 2 : 1,
        will: item.id === "druid" ? good[level - 1] : poor[level - 1],
        willRank: item.id === "druid" ? 2 : 1,
      }),
    },
  );
  assert.deepEqual(result.saves, { fort: 3, ref: 3, will: 3 });
  assert.deepEqual(result.rows.map((row) => row.ref), [2, 1, 0]);
  assert.deepEqual(result.rows.map((row) => row.will), [2, 1, 0]);
});

test("uses the higher BAB category rather than the larger isolated gain", () => {
  const medium = { id: "medium" };
  const low = { id: "low" };
  const items = new Map([[medium.id, medium], [low.id, low]]);
  const result = calculateGestaltLevelProgression(
    [{ mainClassId: medium.id, secondaryClassId: low.id }],
    {
      getItem: (id) => items.get(id),
      getStats: (item) => item.id === medium.id
        ? { hitDice: 1, bab: 0, babRank: 2, fort: 0, ref: 0, will: 0 }
        : { hitDice: 1, bab: 1, babRank: 1, fort: 0, ref: 0, will: 0 },
    },
  );

  assert.equal(result.bab, 0);
  assert.equal(result.rows[0].bab, 0);
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
