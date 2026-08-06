import assert from "node:assert/strict";
import test from "node:test";
import {
  createLevelArray,
  normalizeLevelArray,
  reconcileLevelArray,
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
    swapLevelAssignments(levels, { index: 0, track: "main" }, { index: 1, track: "main" }),
    [
      { level: 1, mainClassId: "rogue", secondaryClassId: "wizard" },
      { level: 2, mainClassId: "fighter", secondaryClassId: "cleric" },
    ],
  );
});

test("dropping onto an empty slot moves the class", () => {
  const levels = [
    { level: 1, mainClassId: "fighter", secondaryClassId: "wizard" },
    { level: 2, mainClassId: null, secondaryClassId: "cleric" },
  ];
  assert.deepEqual(
    swapLevelAssignments(levels, { index: 0, track: "main" }, { index: 1, track: "main" }),
    [
      { level: 1, mainClassId: null, secondaryClassId: "wizard" },
      { level: 2, mainClassId: "fighter", secondaryClassId: "cleric" },
    ],
  );
});

test("rejects swaps between main and secondary tracks", () => {
  const levels = [
    { level: 1, mainClassId: "fighter", secondaryClassId: "wizard" },
    { level: 2, mainClassId: "rogue", secondaryClassId: "cleric" },
  ];
  assert.deepEqual(
    swapLevelAssignments(levels, { index: 0, track: "main" }, { index: 1, track: "secondary" }),
    levels,
  );
});

test("adds a new class level to the first open slot without rebuilding order", () => {
  const levels = [
    { level: 1, mainClassId: "rogue", secondaryClassId: "wizard" },
    { level: 2, mainClassId: "fighter", secondaryClassId: null },
  ];
  assert.deepEqual(
    reconcileLevelArray(levels, [
      cls("fighter", 1, "main"),
      cls("rogue", 1, "main"),
      cls("wizard", 2, "secondary"),
    ]),
    [
      { level: 1, mainClassId: "rogue", secondaryClassId: "wizard" },
      { level: 2, mainClassId: "fighter", secondaryClassId: "wizard" },
    ],
  );
});

test("removes the last matching slot when a class loses a level", () => {
  const levels = [
    { level: 1, mainClassId: "fighter", secondaryClassId: "wizard" },
    { level: 2, mainClassId: "rogue", secondaryClassId: "wizard" },
    { level: 3, mainClassId: "fighter", secondaryClassId: null },
  ];
  assert.deepEqual(
    reconcileLevelArray(levels, [
      cls("fighter", 1, "main"),
      cls("rogue", 1, "main"),
      cls("wizard", 2, "secondary"),
    ]),
    [
      { level: 1, mainClassId: "fighter", secondaryClassId: "wizard" },
      { level: 2, mainClassId: "rogue", secondaryClassId: "wizard" },
    ],
  );
});
