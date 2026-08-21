import { getClassSubtype, isFixedClass } from "./gestalt-calculator.mjs";
import { normalizeLevelArray } from "./gestalt-levels.mjs";

/**
 * Calculate gestalt skill-rank allowances from the per-level class array.
 * Class ranks, background ranks, and favored-class skill bonuses are each
 * compared independently at every character level.
 */
export function calculateGestaltSkillRanks(
  value,
  classes,
  {
    intMod = 0,
    mindless = false,
    useBackgroundSkills = false,
    backgroundClasses = ["base", "prestige"],
    backgroundPerLevel = 2,
    getHitDice = () => 1,
  } = {},
) {
  const levels = normalizeLevelArray(value);
  const byId = new Map(classes.map((item) => [item.id, item]));
  const occurrences = new Map();
  const result = { adventure: 0, background: 0, favored: 0 };

  const advance = (item) => {
    if (!item) return { adventure: 0, background: 0, favored: 0 };
    const classLevel = (occurrences.get(item.id) ?? 0) + 1;
    occurrences.set(item.id, classLevel);
    return levelRanks(item, classLevel, {
      intMod,
      mindless,
      useBackgroundSkills,
      backgroundClasses,
      backgroundPerLevel,
      hitDice: getHitDice(item, classLevel),
    });
  };

  for (const row of levels) {
    const main = advance(byId.get(row.mainClassId));
    const secondary = advance(byId.get(row.secondaryClassId));
    result.adventure += Math.max(main.adventure, secondary.adventure);
    result.background += Math.max(main.background, secondary.background);
    result.favored += main.favored + secondary.favored;
  }

  // Racial hit dice remain additive and do not occupy gestalt rows. Mythic
  // tiers grant no ordinary skill ranks in PF1e.
  for (const item of classes.filter((entry) => isFixedClass(entry) && getClassSubtype(entry) !== "mythic")) {
    const classLevels = Math.max(0, Number(item.system?.level) || 0);
    for (let classLevel = 1; classLevel <= classLevels; classLevel++) {
      const ranks = levelRanks(item, classLevel, {
        intMod,
        mindless,
        useBackgroundSkills,
        backgroundClasses,
        backgroundPerLevel,
        hitDice: getHitDice(item, classLevel),
      });
      result.adventure += ranks.adventure;
      result.background += ranks.background;
      result.favored += ranks.favored;
    }
  }

  result.adventure += result.favored;
  return result;
}

/** Apply PF1's adventure-to-background transfer after base allowances have
 * been calculated. */
export function calculateSkillRankDisplay(ranks, { backgroundUsed = 0, useBackgroundSkills = false } = {}) {
  const result = {
    adventure: Number(ranks?.adventure) || 0,
    background: Number(ranks?.background) || 0,
    transferred: 0,
  };
  if (useBackgroundSkills && backgroundUsed > result.background) {
    result.transferred = backgroundUsed - result.background;
    result.adventure -= result.transferred;
    result.background += result.transferred;
  }
  return result;
}

function levelRanks(
  item,
  classLevel,
  { intMod, mindless, useBackgroundSkills, backgroundClasses, backgroundPerLevel, hitDice },
) {
  const subtype = getClassSubtype(item) ?? "base";
  const favoredTotal = Number(item.system?.fc?.skill?.value) || 0;
  const favored = favoredTotal >= classLevel ? 1 : 0;
  if (mindless) return { adventure: 0, background: 0, favored };

  const perLevel = Number(item.system?.skillsPerLevel) || 0;
  const hd = Math.max(0, Number(hitDice) || 0);
  const adventure = Math.max(1, perLevel + (Number(intMod) || 0)) * hd;
  const grantsBackgroundRanks = typeof backgroundClasses?.has === "function"
    ? backgroundClasses.has(subtype)
    : backgroundClasses?.includes?.(subtype) === true;
  const background = useBackgroundSkills && grantsBackgroundRanks
    ? Math.max(0, Number(backgroundPerLevel) || 0) * hd
    : 0;
  return { adventure, background, favored };
}
