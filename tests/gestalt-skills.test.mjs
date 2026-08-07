import assert from "node:assert/strict";
import test from "node:test";
import { calculateGestaltSkillRanks } from "../scripts/gestalt-skills.mjs";

function cls(id, skillsPerLevel, { level = 1, track = "main", subtype = "base", favored = 0 } = {}) {
  return {
    id,
    flags: { "pf1-gestalt": { track } },
    hitDice: level,
    system: {
      level,
      subType: subtype,
      skillsPerLevel,
      fc: { skill: { value: favored } },
    },
  };
}

test("takes the better skill allowance at each gestalt level", () => {
  const classes = [
    cls("fighter", 2, { level: 2 }),
    cls("rogue", 8, { level: 2, track: "secondary" }),
  ];
  const result = calculateGestaltSkillRanks(
    [
      { mainClassId: "fighter", secondaryClassId: "rogue" },
      { mainClassId: "fighter", secondaryClassId: "rogue" },
    ],
    classes,
    { intMod: 2 },
  );
  assert.deepEqual(result, { adventure: 20, background: 0, favored: 0 });
});

test("applies the minimum one rank per hit die", () => {
  const wizard = cls("wizard", 2);
  const result = calculateGestaltSkillRanks(
    [{ mainClassId: "wizard", secondaryClassId: null }],
    [wizard],
    { intMod: -5 },
  );
  assert.equal(result.adventure, 1);
});

test("does not double favored-class skill bonuses across paired tracks", () => {
  const classes = [
    cls("fighter", 2, { favored: 1 }),
    cls("rogue", 8, { track: "secondary", favored: 1 }),
  ];
  const result = calculateGestaltSkillRanks(
    [{ mainClassId: "fighter", secondaryClassId: "rogue" }],
    classes,
    { intMod: 0 },
  );
  assert.deepEqual(result, { adventure: 9, background: 0, favored: 1 });
});

test("calculates background ranks independently from adventure ranks", () => {
  const classes = [
    cls("npc", 6, { subtype: "npc" }),
    cls("wizard", 2, { track: "secondary" }),
  ];
  const result = calculateGestaltSkillRanks(
    [{ mainClassId: "npc", secondaryClassId: "wizard" }],
    classes,
    { useBackgroundSkills: true },
  );
  assert.deepEqual(result, { adventure: 6, background: 2, favored: 0 });
});

test("mindless characters receive only explicitly recorded favored ranks", () => {
  const rogue = cls("rogue", 8, { favored: 1 });
  const result = calculateGestaltSkillRanks(
    [{ mainClassId: "rogue", secondaryClassId: null }],
    [rogue],
    { mindless: true, useBackgroundSkills: true },
  );
  assert.deepEqual(result, { adventure: 1, background: 0, favored: 1 });
});
