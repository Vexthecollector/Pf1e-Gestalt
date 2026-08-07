import assert from "node:assert/strict";
import test from "node:test";
import { replaceSourceEntries, updateSourceEntry } from "../scripts/gestalt-sources.mjs";

test("replaces only matching class source entries", () => {
  const sourceInfo = {
    hp: {
      positive: [
        { name: "Constitution", value: 6 },
        { name: "Druid", value: 16, classSource: true },
        { name: "Rogue", value: 12, classSource: true },
      ],
      negative: [{ name: "Drain", value: -2 }],
    },
  };

  replaceSourceEntries(sourceInfo, "hp", {
    matches: (entry) => entry.classSource === true,
    name: "Gestalt Classes",
    value: 16,
    id: "pf1-gestalt.class-progression",
  });

  assert.deepEqual(sourceInfo.hp, {
    positive: [
      { name: "Constitution", value: 6 },
      { name: "Gestalt Classes", value: 16, id: "pf1-gestalt.class-progression" },
    ],
    negative: [{ name: "Drain", value: -2 }],
  });
});

test("updates the Constitution source without changing other entries", () => {
  const sourceInfo = {
    hp: {
      positive: [
        { name: "Constitution", value: 6 },
        { name: "Gestalt Classes", value: 16 },
      ],
      negative: [],
    },
  };

  assert.equal(
    updateSourceEntry(sourceInfo, "hp", (entry) => entry.name === "Constitution", 3),
    true,
  );
  assert.deepEqual(sourceInfo.hp.positive, [
    { name: "Constitution", value: 3 },
    { name: "Gestalt Classes", value: 16 },
  ]);
});
