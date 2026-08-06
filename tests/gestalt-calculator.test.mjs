import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateGestaltHealth,
  calculateGestaltLevelProgression,
  calculateGestaltProgression,
  isFixedClass,
} from "../scripts/gestalt-calculator.mjs";

function cls({ track = "main", level, hd = level, bab, fort, ref, will, subType = "base" }) {
  return {
    flags: { "pf1-gestalt": { track } },
    system: {
      subType,
      level,
      hitDice: hd,
      babBase: bab,
      savingThrows: { fort: { base: fort }, ref: { base: ref }, will: { base: will } },
    },
  };
}

test("uses the better progression without stacking both tracks", () => {
  const result = calculateGestaltProgression([
    cls({ level: 5, bab: 5, fort: 4, ref: 1, will: 1 }),
    cls({ track: "secondary", level: 5, bab: 2, fort: 1, ref: 1, will: 4 }),
  ]);

  assert.equal(result.level, 5);
  assert.equal(result.hitDice, 5);
  assert.equal(result.bab, 5);
  assert.deepEqual(result.saves, { fort: 4, ref: 1, will: 4 });
});

test("existing unflagged classes remain on the main track", () => {
  const item = cls({ level: 3, bab: 3, fort: 3, ref: 1, will: 1 });
  delete item.flags;
  const result = calculateGestaltProgression([item]);
  assert.equal(result.active, false);
  assert.equal(result.level, 3);
});

test("racial and mythic classes remain additive", () => {
  const result = calculateGestaltProgression(
    [
      cls({ level: 4, bab: 4, fort: 4, ref: 1, will: 1 }),
      cls({ track: "secondary", level: 4, bab: 2, fort: 1, ref: 1, will: 4 }),
      cls({ level: 2, bab: 2, fort: 3, ref: 0, will: 0, subType: "racial" }),
    ],
  );
  assert.equal(result.level, 6);
  assert.equal(result.bab, 6);
  assert.deepEqual(result.saves, { fort: 7, ref: 1, will: 4 });
});

test("detects fixed classes from live-item and plain-object shapes", () => {
  assert.equal(isFixedClass({ subType: "racial" }), true);
  assert.equal(isFixedClass({ system: { subType: "mythic" } }), true);
  assert.equal(isFixedClass({ subType: "base", system: { subType: "racial" } }), false);
  assert.equal(isFixedClass({ system: { subType: "base" } }), false);
});

test("uses only the higher automatic HP track", () => {
  const fighter = cls({ level: 1, bab: 1, fort: 2, ref: 0, will: 0 });
  fighter.system.hd = 10;
  fighter.system.subType = "base";
  const wizard = cls({ track: "secondary", level: 1, bab: 0, fort: 0, ref: 0, will: 2 });
  wizard.system.hd = 6;
  wizard.system.subType = "base";
  const config = {
    rounding: "up",
    continuous: false,
    maximized: 1,
    getActorConfig: () => ({
      classes: {
        base: { auto: true, rate: 0.5, maximized: true },
        racial: { auto: true, rate: 0.5, maximized: false },
        npc: { auto: true, rate: 0.5, maximized: false },
      },
    }),
  };

  assert.deepEqual(calculateGestaltHealth([fighter, wizard], config), {
    standard: 14,
    gestalt: 10,
    main: 10,
    secondary: 6,
  });
});

test("uses only the higher manually entered HP track", () => {
  const main = cls({ level: 2, bab: 2, fort: 3, ref: 0, will: 0 });
  main.system.subType = "base";
  main.system.hp = 17;
  const secondary = cls({ track: "secondary", level: 2, bab: 1, fort: 0, ref: 0, will: 3 });
  secondary.system.subType = "base";
  secondary.system.hp = 12;
  const config = {
    rounding: "up",
    continuous: false,
    maximized: 1,
    getActorConfig: () => ({
      classes: {
        base: { auto: false },
        racial: { auto: false },
        npc: { auto: false },
      },
    }),
  };

  assert.deepEqual(calculateGestaltHealth([main, secondary], config), {
    standard: 29,
    gestalt: 17,
    main: 17,
    secondary: 12,
  });
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
  });
});
