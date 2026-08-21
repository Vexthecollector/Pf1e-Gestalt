import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCumulativeHitDice,
  calculateClassHealth,
  calculateGestaltClassHealth,
  calculateGestaltLevelProgression,
  getStoredTrack,
  getTrack,
  isFixedClass,
  selectGestaltLevelHealth,
  shorterClassTrack,
} from "../scripts/gestalt-calculator.mjs";

test("distinguishes stored tracks and balances newly added classes", () => {
  const cls = (id, level, track) => ({
    id,
    flags: track ? { "pf1-gestalt": { track } } : {},
    system: { level, subType: "base" },
  });
  const unassigned = cls("new", 0, null);
  assert.equal(getStoredTrack(unassigned), null);
  assert.equal(getTrack(unassigned), "main");
  assert.equal(shorterClassTrack([]), "main");
  assert.equal(shorterClassTrack([cls("fighter", 2, "main")]), "secondary");
  assert.equal(shorterClassTrack([
    cls("fighter", 2, "main"),
    cls("wizard", 2, "secondary"),
  ]), "main");
  assert.equal(shorterClassTrack([
    cls("fighter", 2, "main"),
    cls("wizard", 2, "secondary"),
  ], null), null);
});

test("evaluates named and custom hit-die progressions cumulatively", () => {
  const evaluateFormula = (_formula, data) => data.level * 0.75 + 1;
  const progressions = { animal: { formula: "animal progression" } };
  const animal = { system: { subType: "base", progression: "animal" } };
  const custom = { system: { subType: "base", progression: "custom", customHD: "custom progression" } };

  assert.equal(calculateCumulativeHitDice(animal, 4, { progressions, evaluateFormula }), 4);
  assert.equal(calculateCumulativeHitDice(custom, 2, { progressions, evaluateFormula }), 2.5);
  assert.equal(calculateCumulativeHitDice({ system: { subType: "base" } }, 3), 3);
});

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
    { value: 8, consumesMaximized: 1 },
  );
});

test("adds favored HP from both classes after selecting the better health", () => {
  assert.deepEqual(
    selectGestaltLevelHealth(
      { value: 12, favored: 1, maximized: true },
      { value: 6, favored: 1, maximized: true },
    ),
    { value: 14, consumesMaximized: 1 },
  );
});

test("consumes every maximized hit die gained at one class level", () => {
  assert.deepEqual(
    selectGestaltLevelHealth(
      { value: 16, favored: 0, maximized: 2 },
      { value: 12, favored: 0, maximized: 1 },
    ),
    { value: 16, consumesMaximized: 2 },
  );
});

test("reconstructs standard maximized HP in PF1 class sort order", () => {
  const healthConfig = {
    rounding: "nearest",
    continuous: false,
    maximized: 1,
    getActorConfig: () => ({
      classes: {
        racial: { auto: true, rate: 0.5, maximized: true },
        base: { auto: true, rate: 0.5, maximized: true },
        npc: { auto: true, rate: 0.5, maximized: true },
      },
    }),
  };
  const classes = [
    { sort: 20, subType: "base", hitDice: 1, system: { hd: 12, level: 1, fc: { hp: { value: 0 } } } },
    { sort: 10, subType: "base", hitDice: 1, system: { hd: 6, level: 1, fc: { hp: { value: 0 } } } },
  ];

  assert.equal(calculateClassHealth(classes, healthConfig), 13);
});

test("uses PF1e 11.11 per-source rounding for continuous class health", () => {
  const healthConfig = {
    rounding: "down",
    maximized: 0,
    getActorConfig: () => ({
      continuous: true,
      classes: {
        racial: { auto: true, rate: 0.5, maximized: false },
        base: { auto: true, rate: 0.5, maximized: false },
        npc: { auto: true, rate: 0.5, maximized: false },
      },
    }),
  };
  const classes = ["fighter", "wizard"].map((id) => ({
    id,
    hitDice: 1,
    system: { subType: "base", hd: 8, level: 1, fc: { hp: { value: 0 } } },
  }));

  assert.equal(calculateClassHealth(classes, healthConfig), 8);
});

test("retains PF1e 11.8 aggregate continuous class health", () => {
  const healthConfig = {
    continuous: true,
    rounding: "down",
    maximized: 0,
    getActorConfig: () => ({
      classes: {
        racial: { auto: true, rate: 0.5, maximized: false },
        base: { auto: true, rate: 0.5, maximized: false },
        npc: { auto: true, rate: 0.5, maximized: false },
      },
    }),
  };
  const classes = ["fighter", "wizard"].map((id) => ({
    id,
    hitDice: 1,
    system: { subType: "base", hd: 8, level: 1, fc: { hp: { value: 0 } } },
  }));

  assert.equal(calculateClassHealth(classes, healthConfig), 9);
});

test("rounds fixed and paired health as separate PF1e 11.11 sources", () => {
  const healthConfig = {
    rounding: "down",
    maximized: 0,
    getActorConfig: () => ({
      continuous: true,
      classes: {
        racial: { auto: true, rate: 0.5, maximized: false },
        base: { auto: true, rate: 0.5, maximized: false },
        npc: { auto: true, rate: 0.5, maximized: false },
      },
    }),
  };
  const classes = [
    { id: "racial", hitDice: 1, system: { subType: "racial", hd: 8, level: 1 } },
    { id: "fighter", hitDice: 1, system: { subType: "base", hd: 8, level: 1 } },
    { id: "wizard", hitDice: 1, system: { subType: "base", hd: 8, level: 1 } },
  ];
  const byId = new Map(classes.map((item) => [item.id, item]));
  const result = calculateGestaltClassHealth(
    classes,
    [{ mainClassId: "fighter", secondaryClassId: "wizard" }],
    healthConfig,
    { getItem: (id) => byId.get(id), getHitDice: () => 1 },
  );

  assert.deepEqual(result, { standard: 12, gestalt: 8 });
});
