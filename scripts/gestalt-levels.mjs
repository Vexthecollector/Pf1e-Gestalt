import { getTrack, isFixedClass, TRACK } from "./gestalt-calculator.mjs";

export const LEVELS_FLAG = "levels";

/**
 * Normalize stored gestalt advancement into sequential level rows.
 */
export function normalizeLevelArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row, index) => {
    const mainClassId = row?.mainClassId || null;
    const secondaryClassId = row?.secondaryClassId === mainClassId ? null : row?.secondaryClassId || null;
    return {
      level: index + 1,
      mainClassId,
      secondaryClassId,
    };
  });
}

/**
 * Seed level rows from the class-level and track flags used by version 0.2.1.
 */
export function createLevelArray(classes) {
  const tracks = {
    [TRACK.MAIN]: [],
    [TRACK.SECONDARY]: [],
  };

  const eligible = [...classes]
    .filter((item) => !isFixedClass(item))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));

  for (const item of eligible) {
    const levels = Math.max(0, Number(item.system?.level) || 0);
    const track = getTrack(item);
    for (let level = 0; level < levels; level++) tracks[track].push(item.id);
  }

  const rowCount = Math.max(tracks[TRACK.MAIN].length, tracks[TRACK.SECONDARY].length);
  return normalizeLevelArray(
    Array.from({ length: rowCount }, (_, index) => ({
      mainClassId: tracks[TRACK.MAIN][index] ?? null,
      secondaryClassId: tracks[TRACK.SECONDARY][index] ?? null,
    })),
  );
}

/**
 * Exchange two slots in the stored per-level advancement array.
 */
export function swapLevelAssignments(value, source, target) {
  const levels = normalizeLevelArray(value);
  const keys = { main: "mainClassId", secondary: "secondaryClassId" };
  const sourceKey = keys[source?.track];
  const targetKey = keys[target?.track];
  if (source?.track !== target?.track) return levels;
  const sourceRow = levels[Number(source?.index)];
  const targetRow = levels[Number(target?.index)];
  if (!sourceKey || !targetKey || !sourceRow || !targetRow) return levels;

  const held = sourceRow[sourceKey];
  sourceRow[sourceKey] = targetRow[targetKey];
  targetRow[targetKey] = held;
  return normalizeLevelArray(levels);
}

/** Confirm that a drag source belongs to the same actor and track as its
 * target before changing any stored assignments. */
export function isValidGestaltDrop(source, target) {
  return source?.type === "pf1-gestalt-slot"
    && typeof source.actorId === "string"
    && source.actorId.length > 0
    && source.actorId === target?.actorId
    && source.track === target?.track;
}

/**
 * Match stored slots to current class levels without discarding the player's
 * level ordering. Missing levels fill the first open slot on their track.
 */
export function reconcileLevelArray(value, classes) {
  const levels = normalizeLevelArray(value);
  const keys = { [TRACK.MAIN]: "mainClassId", [TRACK.SECONDARY]: "secondaryClassId" };
  const desired = { [TRACK.MAIN]: new Map(), [TRACK.SECONDARY]: new Map() };

  for (const item of classes.filter((entry) => !isFixedClass(entry))) {
    desired[getTrack(item)].set(item.id, Math.max(0, Number(item.system?.level) || 0));
  }

  for (const track of [TRACK.MAIN, TRACK.SECONDARY]) {
    const key = keys[track];
    const actual = new Map();
    for (const row of levels) {
      if (row[key]) actual.set(row[key], (actual.get(row[key]) ?? 0) + 1);
    }

    for (const [id, count] of actual) {
      let excess = count - (desired[track].get(id) ?? 0);
      for (let index = levels.length - 1; excess > 0 && index >= 0; index--) {
        if (levels[index][key] === id) {
          levels[index][key] = null;
          excess -= 1;
        }
      }
    }

    for (const [id, count] of desired[track]) {
      const current = levels.reduce((sum, row) => sum + (row[key] === id ? 1 : 0), 0);
      for (let missing = count - current; missing > 0; missing--) {
        let row = levels.find((entry) => !entry[key]);
        if (!row) {
          row = { level: levels.length + 1, mainClassId: null, secondaryClassId: null };
          levels.push(row);
        }
        row[key] = id;
      }
    }
  }

  while (levels.length && !levels.at(-1).mainClassId && !levels.at(-1).secondaryClassId) levels.pop();
  return normalizeLevelArray(levels);
}
