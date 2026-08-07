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
  const tracks = {
    main: { bab: 0, saves: { fort: 0, ref: 0, will: 0 } },
    secondary: { bab: 0, saves: { fort: 0, ref: 0, will: 0 } },
  };
  const selected = { bab: 0, saves: { fort: 0, ref: 0, will: 0 } };
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

    tracks.main.bab += Number(mainStats.bab) || 0;
    tracks.secondary.bab += Number(secondaryStats.bab) || 0;
    const nextBAB = Math.max(tracks.main.bab, tracks.secondary.bab);
    gained.bab = nextBAB - selected.bab;
    selected.bab = nextBAB;
    for (const save of ["fort", "ref", "will"]) {
      tracks.main.saves[save] += Number(mainStats[save]) || 0;
      tracks.secondary.saves[save] += Number(secondaryStats[save]) || 0;
      const nextSave = Math.max(tracks.main.saves[save], tracks.secondary.saves[save]);
      gained[save] = nextSave - selected.saves[save];
      selected.saves[save] = nextSave;
    }
    rows.push(gained);
  }

  totals.bab = selected.bab;
  totals.saves = { ...selected.saves };

  for (const stats of fixedStats) {
    totals.hitDice += Number(stats.hitDice) || 0;
    totals.bab += Number(stats.bab) || 0;
    for (const save of ["fort", "ref", "will"]) totals.saves[save] += Number(stats[save]) || 0;
  }
  return { ...totals, rows };
}

/** Select the higher per-level health result while consuming any maximized
 * hit-die opportunity present at that character level. */
export function selectGestaltLevelHealth(main, secondary) {
  const selected = main.value >= secondary.value ? main : secondary;
  return {
    value: selected.value,
    consumesMaximized: main.maximized === true || secondary.maximized === true,
  };
}
