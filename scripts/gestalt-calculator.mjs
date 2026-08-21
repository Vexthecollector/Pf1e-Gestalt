export const TRACK = Object.freeze({
  MAIN: "main",
  SECONDARY: "secondary",
});

export function getStoredTrack(item) {
  const track = item?.flags?.["pf1-gestalt"]?.track;
  return track === TRACK.MAIN || track === TRACK.SECONDARY ? track : null;
}

export function getTrack(item) {
  return getStoredTrack(item) ?? TRACK.MAIN;
}

/** Choose the shorter existing track. Newly created classes use the main track
 * as their tie-breaker; callers comparing track lengths may request another
 * tie value, including null. */
export function shorterClassTrack(classes, tieTrack = TRACK.MAIN) {
  const totals = { [TRACK.MAIN]: 0, [TRACK.SECONDARY]: 0 };
  for (const item of classes ?? []) {
    if (isFixedClass(item)) continue;
    totals[getTrack(item)] += Math.max(0, Number(item.system?.level) || 0);
  }
  if (totals[TRACK.MAIN] === totals[TRACK.SECONDARY]) return tieTrack;
  return totals[TRACK.MAIN] < totals[TRACK.SECONDARY] ? TRACK.MAIN : TRACK.SECONDARY;
}

export function getClassSubtype(item) {
  return item?.subType ?? item?.system?.subType;
}

export function isFixedClass(item) {
  return ["racial", "mythic"].includes(getClassSubtype(item));
}

/** Evaluate the cumulative hit dice granted by a class at a given class
 * level, including PF1e 11.11's named animal and eidolon progressions. */
export function calculateCumulativeHitDice(
  item,
  level,
  { progressions = {}, evaluateFormula = () => 0 } = {},
) {
  if (!item || level <= 0 || getClassSubtype(item) === "mythic") return 0;
  const progression = item.system?.progression;
  const custom = item.system?.customHD;
  const formula = progression === "custom"
    ? custom
    : progressions?.[progression]?.formula ?? (!progression && custom ? custom : null);
  if (typeof formula === "string" && formula.trim()) {
    return Math.max(0, Number(evaluateFormula(formula, { item: { level }, level })) || 0);
  }
  return level;
}

/**
 * Reproduce PF1 v11's class-health calculation for a set of classes.
 */
export function calculateClassHealth(classes, healthConfig, actorType = "character") {
  const { actorConfig, continuous, round, roundsPerSource } = healthCalculationContext(healthConfig, actorType);
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
        if (!continuous) dieHealth = round(dieHealth);
        const hitDice = Number(item.hitDice ?? item.system?.hitDice) || 0;
        const remaining = Math.max(0, (Number(healthConfig.maximized) || 0) - state.maximized);
        const maximized = config.maximized ? Math.min(hitDice, remaining) : 0;
        state.maximized += maximized;
        health = maximized * hpPerHD + Math.max(0, hitDice - maximized) * dieHealth;
      }
    }
    else {
      health = Number(item.system?.hp) || 0;
      if (!continuous) health = round(health);
    }

    // PF1e 11.11's change system requires every generated class-health source
    // to be integral, even when continuous health is configured.
    if (roundsPerSource) health = round(health);

    const subType = getClassSubtype(item);
    const favored = ["base", "prestige", "npc"].includes(subType);
    const favoredHp = favored ? Number(item.system?.fc?.hp?.value) || 0 : 0;
    return health + favoredHp;
  };

  // PF1 sorts class items before dividing them into health categories. This
  // determines which hit dice consume the limited maximized-HD allowance.
  const sorted = [...classes].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  const categories = [
    [sorted.filter((item) => getClassSubtype(item) === "racial"), actorConfig.classes.racial],
    [
      sorted.filter((item) => !["racial", "npc"].includes(getClassSubtype(item))),
      actorConfig.classes.base,
    ],
    [sorted.filter((item) => getClassSubtype(item) === "npc"), actorConfig.classes.npc],
  ];

  let total = 0;
  for (const [items, config] of categories) {
    for (const item of items) total += contribution(item, config);
  }
  return total;
}

/** Calculate PF1 class health after pairing ordinary class levels while
 * retaining fixed racial and mythic classes as separate health sources. */
export function calculateGestaltClassHealth(
  classes,
  levels,
  healthConfig,
  {
    actorType = "character",
    getItem = (id) => classes.find((item) => item.id === id),
    getHitDice = () => 1,
  } = {},
) {
  const standard = calculateClassHealth(classes, healthConfig, actorType);
  const { actorConfig, continuous, round, roundsPerSource } = healthCalculationContext(
    healthConfig,
    actorType,
  );
  const state = { remainingMaximized: Math.max(0, Number(healthConfig.maximized) || 0) };

  const fixed = classes.filter(isFixedClass).sort((a, b) => {
    const priority = (item) => getClassSubtype(item) === "racial" ? 0 : 1;
    return priority(a) - priority(b) || (Number(a.sort) || 0) - (Number(b.sort) || 0);
  });
  let fixedHealth = 0;
  for (const item of fixed) {
    fixedHealth += fixedClassHealth(item, {
      actorConfig,
      continuous,
      getHitDice,
      round,
      roundsPerSource,
      state,
    });
  }

  let trackHealth = 0;
  const occurrences = new Map();
  const advance = (item) => {
    if (!item) return emptyLevelHealth();
    const classLevel = (occurrences.get(item.id) ?? 0) + 1;
    occurrences.set(item.id, classLevel);
    return classLevelHealth(item, classLevel, {
      actorConfig,
      continuous,
      getHitDice,
      round,
      state,
    });
  };
  for (const row of levels) {
    const main = getItem(row.mainClassId) ?? null;
    const secondary = getItem(row.secondaryClassId) ?? null;
    if (!main && !secondary) continue;
    const selected = selectGestaltLevelHealth(advance(main), advance(secondary));
    trackHealth += selected.value;
    state.remainingMaximized -= selected.consumesMaximized;
  }

  // Modern PF1e rounds each generated source. Fixed classes retain one source
  // apiece, while all paired class levels form the gestalt class source.
  if (!continuous || roundsPerSource) trackHealth = round(trackHealth);
  return { standard, gestalt: fixedHealth + trackHealth };
}

function healthCalculationContext(healthConfig, actorType) {
  const actorConfig = healthConfig.getActorConfig(actorType);
  const round = { up: Math.ceil, nearest: Math.round, down: Math.floor }[healthConfig.rounding] ?? Math.round;
  const continuous = actorConfig.continuous ?? healthConfig.continuous;
  return {
    actorConfig,
    continuous,
    round,
    roundsPerSource: actorConfig.continuous !== undefined,
  };
}

function fixedClassHealth(
  item,
  { actorConfig, continuous, getHitDice, round, roundsPerSource, state },
) {
  const subtype = getClassSubtype(item);
  const config = subtype === "racial" ? actorConfig.classes.racial : actorConfig.classes.base;
  if (!config.auto) {
    const value = Number(item.system?.hp) || 0;
    return continuous && !roundsPerSource ? value : round(value);
  }

  if (subtype === "mythic") {
    const value = (Number(item.system?.hd) || 0) * (Number(item.system?.level) || 0);
    return roundsPerSource ? round(value) : value;
  }

  let total = 0;
  const count = Math.max(0, Number(item.system?.level) || 0);
  for (let level = 1; level <= count; level++) {
    const result = classLevelHealth(item, level, {
      actorConfig,
      continuous,
      getHitDice,
      round,
      state,
    });
    total += result.value;
    state.remainingMaximized -= result.maximized;
  }
  return roundsPerSource ? round(total) : total;
}

function classLevelHealth(item, classLevel, { actorConfig, continuous, getHitDice, round, state }) {
  if (!item) return emptyLevelHealth();
  const subtype = getClassSubtype(item);
  const config = subtype === "npc" ? actorConfig.classes.npc : actorConfig.classes.base;
  const totalHitDice = Math.max(0, Number(item.hitDice ?? item.system?.hitDice) || 0);
  const hitDice = Math.max(0, Number(getHitDice(item, classLevel)) || 0);
  const classLevels = Math.max(1, Number(item.system?.level) || 1);
  const favored = ["base", "prestige", "npc"].includes(subtype)
    ? (Number(item.system?.fc?.hp?.value) || 0) / classLevels
    : 0;

  if (!config.auto) {
    const total = Number(item.system?.hp) || 0;
    const value = totalHitDice > 0 ? total * hitDice / totalHitDice : 0;
    return { value, favored, maximized: 0 };
  }

  const die = Number(item.system?.hd) || 0;
  const maximized = config.maximized === true
    ? Math.min(hitDice, Math.max(0, state.remainingMaximized))
    : 0;
  let ordinary = 1 + (die - 1) * config.rate;
  if (!continuous) ordinary = round(ordinary);
  const value = maximized * die + Math.max(0, hitDice - maximized) * ordinary;
  return { value, favored, maximized };
}

function emptyLevelHealth() {
  return { value: 0, favored: 0, maximized: 0 };
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
  const rows = [];
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
    const mainStats = advance(main) ?? { hitDice: 0, bab: 0, fort: 0, ref: 0, will: 0 };
    const secondaryStats = advance(secondary) ?? { hitDice: 0, bab: 0, fort: 0, ref: 0, will: 0 };
    const gained = { bab: 0, fort: 0, ref: 0, will: 0 };
    if (!main && !secondary) {
      rows.push(gained);
      continue;
    }
    totals.level += 1;
    totals.hitDice += Math.max(Number(mainStats.hitDice) || 0, Number(secondaryStats.hitDice) || 0);
    gained.bab = selectProgressionGain(main, mainStats, secondary, secondaryStats, "bab");
    totals.bab += gained.bab;
    for (const save of ["fort", "ref", "will"]) {
      gained[save] = selectProgressionGain(main, mainStats, secondary, secondaryStats, save);
      totals.saves[save] += gained[save];
    }
    rows.push(gained);
  }

  for (const stats of fixedStats) {
    totals.hitDice += Number(stats.hitDice) || 0;
    totals.bab += Number(stats.bab) || 0;
    for (const save of ["fort", "ref", "will"]) totals.saves[save] += Number(stats[save]) || 0;
  }
  return { ...totals, rows };
}

/** Choose the gain from the higher progression category. Numeric comparison is
 * retained for equal or custom categories, where neither side is categorically
 * better. */
function selectProgressionGain(main, mainStats, secondary, secondaryStats, stat) {
  const mainGain = Number(mainStats[stat]) || 0;
  const secondaryGain = Number(secondaryStats[stat]) || 0;
  if (!main) return secondaryGain;
  if (!secondary) return mainGain;

  const rankKey = `${stat}Rank`;
  const mainRank = mainStats[rankKey];
  const secondaryRank = secondaryStats[rankKey];
  if (
    Number.isFinite(mainRank)
    && Number.isFinite(secondaryRank)
    && mainRank !== secondaryRank
  ) return mainRank > secondaryRank ? mainGain : secondaryGain;
  return Math.max(mainGain, secondaryGain);
}

/** Select the higher per-level health result while consuming any maximized
 * hit-die opportunity present at that character level. */
export function selectGestaltLevelHealth(main, secondary) {
  const selected = main.value >= secondary.value ? main : secondary;
  return {
    value: selected.value + (Number(main.favored) || 0) + (Number(secondary.favored) || 0),
    consumesMaximized: Math.max(Number(main.maximized) || 0, Number(secondary.maximized) || 0),
  };
}
