import assert from "node:assert/strict";
import test from "node:test";
import {
  createLevelArray,
  normalizeLevelArray,
  swapLevelAssignments,
} from "../scripts/gestalt-levels.mjs";

function cls(id, level, track, subType = "base", sort = 0) {
  return {
    id,
    sort,
    flags: { "pf1-gestalt": { track } },
    system: { level, subType },
  };
}

test("creates level rows from main and secondary classes", () => {
  const levels = createLevelArray([
    cls("fighter", 2, "main"),
    cls("wizard", 2, "secondary"),
  ]);
  assert.deepEqual(levels, [
    { level: 1, mainClassId: "fighter", secondaryClassId: "wizard" },
    { level: 2, mainClassId: "fighter", secondaryClassId: "wizard" },
  ]);
});

test("excludes racial and mythic classes", () => {
  const levels = createLevelArray([
    cls("fighter", 1, "main"),
    cls("racial", 2, "main", "racial"),
    cls("mythic", 1, "secondary", "mythic"),
  ]);
  assert.deepEqual(levels, [{ level: 1, mainClassId: "fighter", secondaryClassId: null }]);
});

test("normalization enforces sequential levels and rejects duplicate sides", () => {
  const levels = normalizeLevelArray([
    { level: 8, mainClassId: "fighter", secondaryClassId: "fighter" },
    { level: 12, mainClassId: "rogue", secondaryClassId: "wizard" },
  ]);
  assert.deepEqual(levels, [
    { level: 1, mainClassId: "fighter", secondaryClassId: null },
    { level: 2, mainClassId: "rogue", secondaryClassId: "wizard" },
  ]);
});

test("swaps classes between gestalt level slots", () => {
  const levels = [
    { level: 1, mainClassId: "fighter", secondaryClassId: "wizard" },
    { level: 2, mainClassId: "rogue", secondaryClassId: "cleric" },
  ];
  assert.deepEqual(
    swapLevelAssignments(levels, { index: 0, track: "main" }, { index: 1, track: "secondary" }),
    [
      { level: 1, mainClassId: "cleric", secondaryClassId: "wizard" },
      { level: 2, mainClassId: "rogue", secondaryClassId: "fighter" },
    ],
  );
});

test("dropping onto an empty slot moves the class", () => {
  const levels = [
    { level: 1, mainClassId: "fighter", secondaryClassId: null },
    { level: 2, mainClassId: "rogue", secondaryClassId: "wizard" },
  ];
  assert.deepEqual(
    swapLevelAssignments(levels, { index: 0, track: "main" }, { index: 0, track: "secondary" }),
    [
      { level: 1, mainClassId: null, secondaryClassId: "fighter" },
      { level: 2, mainClassId: "rogue", secondaryClassId: "wizard" },
    ],
  );
});
