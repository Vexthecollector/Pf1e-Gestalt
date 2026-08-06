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
