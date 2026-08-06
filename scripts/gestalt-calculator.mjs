export const TRACK = Object.freeze({
  MAIN: "main",
  SECONDARY: "secondary",
});

export function getTrack(item) {
  return item?.flags?.["pf1-gestalt"]?.track === TRACK.SECONDARY ? TRACK.SECONDARY : TRACK.MAIN;
}

export function getClassSubtype(item) {
  return item?.subType ?? item?.system?.subType;
}

export function isFixedClass(item) {
  return ["racial", "mythic"].includes(getClassSubtype(item));
}

function sum(items, selector) {
  return items.reduce((total, item) => total + (Number(selector(item)) || 0), 0);
}

/**
 * Calculate replacement class progressions for a gestalt actor.
 * Fixed classes (racial and mythic paths) remain additive. The two gestalt
 * tracks use the better aggregate progression and therefore count only once.
 */
export function calculateGestaltProgression(classes, { fractional = false, isFixed = isFixedClass } = {}) {
  const fixed = classes.filter(isFixed);
  const main = classes.filter((item) => !isFixed(item) && getTrack(item) === TRACK.MAIN);
  const secondary = classes.filter((item) => !isFixed(item) && getTrack(item) === TRACK.SECONDARY);

  const progression = (selector) => sum(fixed, selector) + Math.max(sum(main, selector), sum(secondary, selector));
  const standard = (selector) => sum(classes, selector);
  const finish = (value) => fractional ? Math.floor(value) : value;

  const saves = {};
  const standardSaves = {};
  for (const save of ["fort", "ref", "will"]) {
    const selector = (item) => item.system?.savingThrows?.[save]?.base;
    saves[save] = finish(progression(selector));
    standardSaves[save] = finish(standard(selector));
  }

  return {
    active: secondary.length > 0,
    level: progression((item) => item.system?.level),
    hitDice: progression((item) => item.system?.hitDice),
    bab: finish(progression((item) => item.system?.babBase)),
    saves,
    standard: {
      level: standard((item) => item.system?.level),
      hitDice: standard((item) => item.system?.hitDice),
      bab: finish(standard((item) => item.system?.babBase)),
      saves: standardSaves,
    },
  };
}

/**
 * Reproduce PF1 v11's class-health calculation for a set of classes.
 */
export function calculateClassHealth(classes, healthConfig, actorType = "character") {
  const actorConfig = healthConfig.getActorConfig(actorType);
  const round = { up: Math.ceil, nearest: Math.round, down: Math.floor }[healthConfig.rounding] ?? Math.round;
  const state = { maximized: 0 };

  const contribution = (item, config) => {
    let health;
    if (config.auto) {
      const hpPerHD = Number(item.system?.hd) || 0;
      if (getClassSubtype(item) === "mythic") {
        health = hpPerHD * (Number(item.system?.level) || 0);
      }
      else {
        let dieHealth = 1 + (hpPerHD - 1) * config.rate;
        if (!healthConfig.continuous) dieHealth = round(dieHealth);
        const hitDice = Number(item.hitDice ?? item.system?.hitDice) || 0;
        const remaining = Math.max(0, (Number(healthConfig.maximized) || 0) - state.maximized);
        const maximized = config.maximized ? Math.min(hitDice, remaining) : 0;
        state.maximized += maximized;
        health = maximized * hpPerHD + Math.max(0, hitDice - maximized) * dieHealth;
      }
    }
    else {
      health = Number(item.system?.hp) || 0;
      if (!healthConfig.continuous) health = round(health);
    }

    const subType = getClassSubtype(item);
    const favored = ["base", "prestige", "npc"].includes(subType);
    const favoredHp = favored ? Number(item.system?.fc?.hp?.value) || 0 : 0;
    return health + favoredHp;
  };

  const categories = [
    [classes.filter((item) => getClassSubtype(item) === "racial"), actorConfig.classes.racial],
    [
      classes.filter((item) => !["racial", "npc"].includes(getClassSubtype(item))),
      actorConfig.classes.base,
    ],
    [classes.filter((item) => getClassSubtype(item) === "npc"), actorConfig.classes.npc],
  ];

  let total = 0;
  for (const [items, config] of categories) {
    for (const item of items) total += contribution(item, config);
  }
  return total;
}

export function calculateGestaltHealth(classes, healthConfig, actorType = "character", isFixed = isFixedClass) {
  const fixed = classes.filter(isFixed);
  const main = classes.filter((item) => !isFixed(item) && getTrack(item) === TRACK.MAIN);
  const secondary = classes.filter((item) => !isFixed(item) && getTrack(item) === TRACK.SECONDARY);

  const standard = calculateClassHealth(classes, healthConfig, actorType);
  const mainHealth = calculateClassHealth([...fixed, ...main], healthConfig, actorType);
  const secondaryHealth = calculateClassHealth([...fixed, ...secondary], healthConfig, actorType);
  return { standard, gestalt: Math.max(mainHealth, secondaryHealth), main: mainHealth, secondary: secondaryHealth };
}

/**
 * Calculate progression by choosing the better gain in every stored gestalt
 * row. The callback receives the class item and its occurrence-based class
 * level, allowing Foundry's configured formulas to remain the authority.
 */
export function calculateGestaltLevelProgression(
  levels,
  { getItem, getStats, fixedStats = [] },
) {
  const totals = { level: 0, hitDice: 0, bab: 0, saves: { fort: 0, ref: 0, will: 0 } };
  const occurrences = new Map();
  const advance = (item) => {
    if (!item) return null;
    const level = (occurrences.get(item.id) ?? 0) + 1;
    occurrences.set(item.id, level);
    return getStats(item, level);
  };

  for (const row of levels) {
    const main = getItem(row.mainClassId) ?? null;
    const secondary = getItem(row.secondaryClassId) ?? null;
    if (!main && !secondary) continue;
    const mainStats = advance(main) ?? { hd: 0, bab: 0, fort: 0, ref: 0, will: 0 };
    const secondaryStats = advance(secondary) ?? { hd: 0, bab: 0, fort: 0, ref: 0, will: 0 };
    totals.level += 1;
    totals.hitDice += Math.max(mainStats.hitDice ?? 1, secondaryStats.hitDice ?? 1);
    totals.bab += Math.max(Number(mainStats.bab) || 0, Number(secondaryStats.bab) || 0);
    for (const save of ["fort", "ref", "will"]) {
      totals.saves[save] += Math.max(Number(mainStats[save]) || 0, Number(secondaryStats[save]) || 0);
    }
  }

  for (const stats of fixedStats) {
    totals.hitDice += Number(stats.hitDice) || 0;
    totals.bab += Number(stats.bab) || 0;
    for (const save of ["fort", "ref", "will"]) totals.saves[save] += Number(stats[save]) || 0;
  }
  return totals;
}
