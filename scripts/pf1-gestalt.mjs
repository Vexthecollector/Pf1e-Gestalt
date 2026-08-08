import {
  calculateClassHealth,
  calculateGestaltLevelProgression,
  getClassSubtype,
  getTrack,
  isFixedClass,
  selectGestaltLevelHealth,
  TRACK,
} from "./gestalt-calculator.mjs";
import {
  createLevelArray,
  LEVELS_FLAG,
  normalizeLevelArray,
  reconcileLevelArray,
  swapLevelAssignments,
} from "./gestalt-levels.mjs";
import { calculateGestaltSkillRanks, calculateSkillRankDisplay } from "./gestalt-skills.mjs";
import { replaceSourceEntries, updateSourceEntry } from "./gestalt-sources.mjs";

const MODULE_ID = "pf1-gestalt";
const FLAG_PATH = `flags.${MODULE_ID}.track`;
const reactivateGestaltTab = new WeakSet();
let draggedGestaltSlot = null;

Hooks.once("init", () => {
  console.info("PF1e Gestalt | Initializing main and secondary class tracks");
  game.modules.get(MODULE_ID).api = {
    createLevelArray,
    getLevels: (actor) => normalizeLevelArray(actor?.getFlag(MODULE_ID, LEVELS_FLAG)),
  };
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  for (const actor of game.actors.filter((entry) => entry.type === "character")) {
    await ensureLevelArray(actor);
  }
});

Hooks.on("createActor", async (actor, _options, userId) => {
  if (game.user.id === userId && actor.isOwner && actor.type === "character") await ensureLevelArray(actor);
});

// Keep the level array synchronized even when a class track or level is
// changed somewhere other than the injected Summary-page control.
Hooks.on("updateItem", async (item, changes, options, userId) => {
  if (game.user.id !== userId || options?.pf1GestaltSkipSync === true) return;
  if (item.type !== "class" || item.parent?.type !== "character") return;
  const trackChanged = foundry.utils.hasProperty(changes, FLAG_PATH);
  const levelChanged = foundry.utils.hasProperty(changes, "system.level");
  if (trackChanged || levelChanged) await synchronizeLevelArray(item.parent, { preserveOrder: levelChanged });
});

for (const hook of ["createItem", "deleteItem"]) {
  Hooks.on(hook, async (item, _options, userId) => {
    if (game.user.id !== userId || item.type !== "class" || item.parent?.type !== "character") return;
    await synchronizeLevelArray(item.parent, { preserveOrder: true });
  });
}

async function ensureLevelArray(actor) {
  if (actor.getFlag(MODULE_ID, LEVELS_FLAG) !== undefined) return;
  await actor.setFlag(MODULE_ID, LEVELS_FLAG, createLevelArray(actor.itemTypes?.class ?? []));
}

Hooks.on("pf1PrepareDerivedActorData", (actor) => {
  safelyApplyGestaltProgression(actor);
});

function safelyApplyGestaltProgression(actor) {
  try {
    return applyGestaltProgression(actor);
  }
  catch (error) {
    // Never allow optional gestalt logic to invalidate the PF1 actor model.
    console.error("PF1e Gestalt | Could not apply gestalt progression", error, actor);
    return 0;
  }
}

function applyGestaltProgression(actor) {
  if (actor.type !== "character") return;

  const classes = [...(actor.itemTypes?.class ?? [])];
  // LevelUpForm previews changes on a temporary actor via updateSource(),
  // which does not fire updateItem. Reconcile locally so that preview actor
  // calculations include the prospective gestalt slot.
  const levels = reconcileLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG), classes);
  if (!levels.some((row) => row.secondaryClassId)) return;

  const fractional = useFractionalProgression();
  const result = calculateArrayProgression(actor, classes, levels, fractional);
  if (!result.active) return;

  const healthConfig = game.settings.get("pf1", "healthConfig");
  const health = calculateArrayHealth(actor, classes, levels, healthConfig);
  const classHealthAdjustment = health.gestalt - health.standard;
  const hdAdjustment = result.hitDice - result.standard.hitDice;
  const hpAbility = actor.system.attributes.hpAbility;
  const hpAbilityMod = hpAbility ? Number(actor.system.abilities?.[hpAbility]?.mod) || 0 : 0;

  actor.system.details.level.value += result.level - result.standard.level;
  actor.system.attributes.hd.total += hdAdjustment;
  actor.system.attributes.bab.total += result.bab - result.standard.bab;
  actor.system.attributes.hp.max += classHealthAdjustment + hpAbilityMod * hdAdjustment;
  if (actor.system.attributes.vigor) actor.system.attributes.vigor.max += classHealthAdjustment;

  for (const save of ["fort", "ref", "will"]) {
    const data = actor.system.attributes.savingThrows?.[save];
    if (data) data.total += result.saves[save] - result.standard.saves[save];
  }

  replaceGestaltSourceDetails(actor, classes, result, health, hpAbility, hpAbilityMod);
}

function replaceGestaltSourceDetails(actor, classes, result, health, hpAbility, hpAbilityMod) {
  const sourceInfo = actor.sourceInfo;
  if (!sourceInfo) return;
  const classNames = new Set(classes.map((item) => item.name));
  const gestaltLabel = localize("PF1GESTALT.Source.GestaltClasses");
  const sourceId = `${MODULE_ID}.class-progression`;

  replaceSourceEntries(sourceInfo, "system.attributes.bab.total", {
    matches: (entry) => classNames.has(entry.name) && !entry.change,
    name: gestaltLabel,
    value: result.bab,
    id: sourceId,
  });

  const baseLabel = localize("PF1.Base");
  const goodSaveLabel = localize("PF1.SavingThrowGoodFractionalBonus");
  for (const save of ["fort", "ref", "will"]) {
    const generatedNames = new Set([...classNames, baseLabel, goodSaveLabel]);
    replaceSourceEntries(sourceInfo, `system.attributes.savingThrows.${save}.total`, {
      matches: (entry) => (
        entry.change?.target === save
        && !entry.change.parent
        && generatedNames.has(entry.name)
      ),
      name: gestaltLabel,
      value: result.saves[save],
      id: sourceId,
    });
  }

  const favoredNames = new Set(classes.map((item) => (
    game.i18n.format("PF1.SourceInfoSkillRank_ClassFC", { className: item.name })
  )));
  const healthNames = new Set([...classNames, ...favoredNames]);
  for (const [attribute, target] of [["hp", "mhp"], ["vigor", "vigor"]]) {
    if (!actor.system.attributes[attribute]) continue;
    replaceSourceEntries(sourceInfo, `system.attributes.${attribute}.max`, {
      matches: (entry) => (
        entry.change?.target === target
        && !entry.change.parent
        && healthNames.has(entry.name)
      ),
      name: gestaltLabel,
      value: health.gestalt,
      id: sourceId,
    });
  }

  if (hpAbility) {
    const abilityLabel = pf1.config.abilities[hpAbility];
    updateSourceEntry(
      sourceInfo,
      "system.attributes.hp.max",
      (entry) => entry.change?.target === "mhp" && entry.name === abilityLabel,
      hpAbilityMod * result.hitDice,
    );
  }
}

function useFractionalProgression() {
  try {
    return game.settings.get("pf1", "useFractionalBaseBonuses") === true;
  }
  catch (_error) {
    return false;
  }
}

for (const hook of [
  "renderApplicationV2",
  "renderCharacterSheetPF",
  "renderActorSheetPF",
  "renderActorSheet",
]) {
  Hooks.on(hook, enhanceRenderedSheet);
}

Hooks.on("renderLevelUpForm", adjustGestaltLevelUpForm);
Hooks.on("renderPF1ExtendedTooltip", enhanceGestaltExtendedTooltip);

function adjustGestaltLevelUpForm(app, html) {
  const actor = app.actor;
  const item = app.item;
  if (actor?.type !== "character" || item?.type !== "class" || isFixedClass(item)) return;
  if (!actor.itemTypes.class.some((entry) => !isFixedClass(entry) && getTrack(entry) === TRACK.SECONDARY)) return;
  const lowerTrack = lowerGestaltTrack(actor);
  const catchUp = lowerTrack && getTrack(item) === lowerTrack;

  const element = rootElement(html, app);
  if (catchUp) {
    // PF1e looks up ASIs from the preview actor's total HD without checking
    // whether HD actually increased. A catch-up level fills an existing
    // gestalt row, so suppress repeated milestone and favored-class rewards.
    app.config.abilityScore.new = 0;
    app.config.abilityScore.used = 0;
    for (const ability of Object.values(app.config.abilityScore.upgrades ?? {})) ability.added = 0;
    app.config.fcb.choice = "none";
    app.config.fcb.available = false;
    app.config.fcb.unavailable = true;
    replaceLevelUpSegment(
      element,
      ".segment.ability-score",
      "PF1.LevelUp.AbilityScore.Label",
      "PF1GESTALT.LevelUp.CatchUpASI",
    );
    replaceLevelUpSegment(
      element,
      ".segment.fcb",
      "PF1.LevelUp.FC.Label",
      "PF1GESTALT.LevelUp.CatchUpFCB",
    );
  }

  adjustLevelUpSkillRanks(app, element, catchUp);
  const submit = element?.querySelector("button[type='submit'][data-action='commit']");
  if (submit && typeof app.isReady === "function") submit.disabled = !app.isReady();
}

function replaceLevelUpSegment(element, selector, headingKey, noteKey) {
  const segment = element?.querySelector(selector);
  if (!segment) return;
  const heading = document.createElement("h2");
  heading.textContent = localize(headingKey);
  const note = document.createElement("p");
  note.className = "info pf1-gestalt-catch-up-note";
  note.textContent = localize(noteKey);
  segment.replaceChildren(heading, note);
}

function adjustLevelUpSkillRanks(app, element, catchUp) {
  if (!app.simulacra || !app.config.skills) return;
  const oldRanks = actorGestaltSkillRanks(app.actor);
  const newRanks = actorGestaltSkillRanks(app.simulacra);
  const pendingFavoredRank = !catchUp && app.config.fcb.choice === "skill" ? 1 : 0;
  const adventureDelta = newRanks.adventure - oldRanks.adventure + pendingFavoredRank;
  const backgroundDelta = newRanks.background - oldRanks.background;
  app.config.skills.old = { value: oldRanks.adventure, bg: oldRanks.background };
  app.config.skills.new = { value: newRanks.adventure, bg: newRanks.background };
  app.config.skills.delta = { adv: adventureDelta, bg: backgroundDelta, ranks: adventureDelta };
  app.config.level.skills = adventureDelta + backgroundDelta;

  const skill = element?.querySelector(".summary .details .skill");
  if (!skill) return;
  skill.classList.toggle("disabled", adventureDelta === 0 && backgroundDelta === 0);
  if (app.useBackgroundSkills) {
    const adventure = skill.querySelector(".adventure .value");
    const background = skill.querySelector(".background .value");
    if (adventure) adventure.textContent = signed(adventureDelta);
    if (background) background.textContent = signed(backgroundDelta);
  }
  else {
    const value = skill.querySelector(":scope > .value");
    if (value) value.textContent = signed(adventureDelta);
  }
}

function enhanceRenderedSheet(app, html) {
  const element = rootElement(html, app);
  if (!element) return;

  const actor = app.actor ?? (app.document?.documentName === "Actor" ? app.document : null);
  if (actor?.type === "character") enhanceCharacterSheet(app, element, actor);
}

function enhanceCharacterSheet(app, element, actor) {
  enhanceGestaltPage(app, element, actor);

  const classesBody = element.querySelector(".classes-body");
  if (!classesBody || classesBody.dataset.gestaltEnhanced === "true") return;
  classesBody.dataset.gestaltEnhanced = "true";

  const fixed = actor.itemTypes.class.filter(isFixedClass);
  const main = actor.itemTypes.class.filter((item) => !isFixedClass(item) && getTrack(item) === TRACK.MAIN);
  const secondary = actor.itemTypes.class.filter(
    (item) => !isFixedClass(item) && getTrack(item) === TRACK.SECONDARY,
  );
  classesBody.prepend(buildSummary(main, secondary, fixed));

  for (const row of classesBody.querySelectorAll(".item[data-item-id]")) {
    const item = actor.items.get(row.dataset.itemId);
    if (item?.type !== "class") continue;
    row.classList.add("pf1-gestalt-class-row");
    row.dataset.gestaltTrack = isFixedClass(item) ? "fixed" : getTrack(item);

    const details = document.createElement("div");
    details.className = "item-detail pf1-gestalt-track";
    if (isFixedClass(item)) {
      const fixedLabel = document.createElement("span");
      fixedLabel.className = "pf1-gestalt-fixed-label";
      fixedLabel.textContent = localize("PF1GESTALT.Track.Fixed");
      details.append(fixedLabel);
      insertTrackDetails(row, details);
      continue;
    }

    const select = document.createElement("select");
    select.setAttribute("aria-label", localize("PF1GESTALT.Track.Label"));
    select.disabled = !actor.isOwner;
    select.append(
      option(TRACK.MAIN, localize("PF1GESTALT.Track.Main"), getTrack(item)),
      option(TRACK.SECONDARY, localize("PF1GESTALT.Track.Secondary"), getTrack(item)),
    );
    select.addEventListener("change", async (event) => {
      event.stopPropagation();
      await updateClassTrack(item, event.currentTarget.value);
      renderApp(app);
    });
    details.append(select);
    insertTrackDetails(row, details);
  }
  addCatchUpLevelButtons(app, classesBody, actor);
  adjustCharacterSkillRanks(element, actor);
}

function actorGestaltSkillRanks(actor) {
  const classes = [...(actor.itemTypes?.class ?? [])];
  const levels = reconcileLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG), classes);
  const intelligence = actor.system.abilities?.int;
  const result = calculateGestaltSkillRanks(levels, classes, {
    intMod: intelligence?.mod ?? 0,
    mindless: intelligence?.value === null,
    useBackgroundSkills: game.settings.get("pf1", "allowBackgroundSkills") === true,
    backgroundClasses: pf1.config.backgroundSkillClasses,
    backgroundPerLevel: pf1.config.backgroundSkillsPerLevel,
    getHitDice: classLevelHitDice,
  });
  result.adventure += Number(actor.system.details?.skills?.bonus) || 0;
  return result;
}

function adjustCharacterSkillRanks(element, actor) {
  if (!actor.itemTypes.class.some((item) => !isFixedClass(item) && getTrack(item) === TRACK.SECONDARY)) return;
  const ranks = actorGestaltSkillRanks(actor);
  const adventure = element.querySelector("header.skill-ranks .adventure");
  const background = element.querySelector("header.skill-ranks .background");
  const transferred = element.querySelector("header.skill-ranks .transferred .value");
  if (!adventure) return;

  const used = Number(adventure.querySelector(".used .value")?.textContent) || 0;
  const bgUsed = Number(background?.querySelector(".used .value")?.textContent) || 0;
  const displayed = calculateSkillRankDisplay(ranks, {
    backgroundUsed: bgUsed,
    useBackgroundSkills: Boolean(background),
  });

  const allowedValue = adventure.querySelector(".available .value");
  const usedValue = adventure.querySelector(".used .value");
  const bgAllowedValue = background?.querySelector(".available .value");
  if (allowedValue) allowedValue.textContent = String(displayed.adventure);
  if (usedValue) usedValue.textContent = String(used);
  if (bgAllowedValue) bgAllowedValue.textContent = String(displayed.background);
  if (transferred) transferred.textContent = String(displayed.transferred);
}

function enhanceGestaltExtendedTooltip(sheet, id, template) {
  const actor = sheet.actor;
  if (
    actor?.type !== "character"
    || !["skills.adventure", "skills.background"].includes(id)
    || !actor.itemTypes.class.some((item) => !isFixedClass(item) && getTrack(item) === TRACK.SECONDARY)
  ) return;

  const ranks = actorGestaltSkillRanks(actor);
  const useBackgroundSkills = game.settings.get("pf1", "allowBackgroundSkills") === true;
  const displayed = calculateSkillRankDisplay(ranks, {
    backgroundUsed: usedSkillRanks(actor).background,
    useBackgroundSkills,
  });
  const bonus = Number(actor.system.details?.skills?.bonus) || 0;
  const entries = id === "skills.background"
    ? [{ name: localize("PF1GESTALT.Source.GestaltClasses"), value: ranks.background }]
    : [{ name: localize("PF1GESTALT.Source.GestaltClasses"), value: ranks.adventure - bonus }];

  if (id === "skills.adventure") {
    const bonusSources = actor.getSourceDetails("system.details.skills.bonus") ?? [];
    let describedBonus = 0;
    for (const source of bonusSources) {
      const value = Number(source.value) || 0;
      if (!value || source.disabled) continue;
      entries.push({ name: source.name, value });
      describedBonus += value;
    }
    if (bonus !== describedBonus) {
      entries.push({ name: localize("PF1.BuffTarBonusSkillRanks"), value: bonus - describedBonus });
    }
  }
  if (displayed.transferred) {
    entries.push({
      name: localize("PF1.Transferred"),
      value: id === "skills.background" ? displayed.transferred : -displayed.transferred,
    });
  }
  replaceTooltipSources(template, entries);
}

function usedSkillRanks(actor) {
  const result = { adventure: 0, background: 0 };
  const skills = actor.getRollData?.().skills ?? {};
  const add = (skill, rank) => {
    const key = skill.background ? "background" : "adventure";
    result[key] += Number(rank) || 0;
  };
  for (const skill of Object.values(skills)) {
    if (skill.subSkills != null) {
      for (const subSkill of Object.values(skill.subSkills)) add(skill, subSkill.rank);
    }
    else add(skill, skill.rank);
  }
  return result;
}

function replaceTooltipSources(template, entries) {
  const heading = [...template.content.querySelectorAll("h4")]
    .find((element) => element.textContent.trim() === localize("PF1.FromSources"));
  if (!heading) return;
  const notes = template.content.querySelector("ul.notes");
  let node = heading.nextSibling;
  while (node && node !== notes) {
    const next = node.nextSibling;
    node.remove();
    node = next;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of entries.filter((source) => Number(source.value) !== 0)) {
    const flavor = document.createElement("span");
    flavor.className = "flavor";
    flavor.textContent = entry.name;
    const value = document.createElement("span");
    value.className = "value untyped";
    value.textContent = signed(entry.value);
    fragment.append(flavor, value);
  }
  template.content.insertBefore(fragment, notes);
}

function addCatchUpLevelButtons(app, classesBody, actor) {
  if (!actor.isOwner) return;
  const eligible = actor.itemTypes.class.filter((item) => !isFixedClass(item));
  const lowerTrack = lowerGestaltTrack(actor);
  if (!lowerTrack) return;

  for (const item of eligible.filter((entry) => getTrack(entry) === lowerTrack)) {
    const row = classesBody.querySelector(`.item[data-item-id="${CSS.escape(item.id)}"]`);
    const cell = row?.querySelector(".item-button");
    if (!cell || cell.querySelector(".level-up")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "level-up pf1-gestalt-catch-up";
    button.dataset.itemId = item.id;
    button.textContent = localize("PF1.LevelUp.Action");
    button.addEventListener("click", (event) => app._onLevelUp(event));
    cell.append(button);
  }
}

function lowerGestaltTrack(actor) {
  const eligible = actor.itemTypes.class.filter((item) => !isFixedClass(item));
  const total = (track) => eligible
    .filter((item) => getTrack(item) === track)
    .reduce((sum, item) => sum + (Number(item.system?.level) || 0), 0);
  const main = total(TRACK.MAIN);
  const secondary = total(TRACK.SECONDARY);
  if (main === secondary) return null;
  return main < secondary ? TRACK.MAIN : TRACK.SECONDARY;
}

function calculateArrayProgression(actor, classes, levels, fractional) {
  const fixed = classes.filter(isFixedClass);
  const totals = calculateGestaltLevelProgression(levels, {
    getItem: (id) => actor.items.get(id),
    getStats: (item, level) => ({
      ...classLevelStatistics(item, level, false),
      hitDice: classLevelHitDice(item, level),
    }),
    fixedStats: fixed.map((item) => ({
      hitDice: Number(item.hitDice ?? item.system?.hitDice) || 0,
      bab: Number(item.system?.babBase) || 0,
      fort: Number(item.system?.savingThrows?.fort?.base) || 0,
      ref: Number(item.system?.savingThrows?.ref?.base) || 0,
      will: Number(item.system?.savingThrows?.will?.base) || 0,
    })),
  });

  for (const save of ["fort", "ref", "will"]) {
    if (fractional && hasGoodFractionalSave(actor, levels, fixed, save)) {
      totals.saves[save] += fractionalGoodSaveBonus();
    }
    totals.saves[save] = fractional ? Math.floor(totals.saves[save]) : totals.saves[save];
  }
  totals.bab = Math.floor(totals.bab);

  const standardEligible = classes.filter((item) => !isFixedClass(item));
  const standard = {
    level: standardEligible.reduce((sum, item) => sum + (Number(item.system?.level) || 0), 0),
    hitDice: classes.reduce((sum, item) => sum + (Number(item.hitDice ?? item.system?.hitDice) || 0), 0),
    bab: Math.floor(classes.reduce((sum, item) => sum + (Number(item.system?.babBase) || 0), 0)),
    saves: {},
  };
  for (const save of ["fort", "ref", "will"]) {
    let value = classes.reduce(
      (sum, item) => sum + (Number(item.system?.savingThrows?.[save]?.base) || 0),
      0,
    );
    if (fractional && classes.some((item) => item.system?.savingThrows?.[save]?.good === true)) {
      value += fractionalGoodSaveBonus();
    }
    standard.saves[save] = fractional ? Math.floor(value) : value;
  }

  return { active: levels.some((row) => row.secondaryClassId), ...totals, standard };
}

function hasGoodFractionalSave(actor, levels, fixed, save) {
  const ids = new Set();
  for (const row of levels) {
    if (row.mainClassId) ids.add(row.mainClassId);
    if (row.secondaryClassId) ids.add(row.secondaryClassId);
  }
  return [...fixed, ...[...ids].map((id) => actor.items.get(id)).filter(Boolean)]
    .some((item) => item.system?.savingThrows?.[save]?.good === true);
}

function fractionalGoodSaveBonus() {
  const formula = pf1.config.classFractionalSavingThrowFormulas?.goodSaveBonus ?? "2";
  return Number(pf1.dice.RollPF.safeRollSync(formula).total) || 0;
}

function calculateArrayHealth(actor, classes, levels, healthConfig) {
  const standard = calculateClassHealth(classes, healthConfig, actor.type);
  const actorConfig = healthConfig.getActorConfig(actor.type);
  const round = { up: Math.ceil, nearest: Math.round, down: Math.floor }[healthConfig.rounding] ?? Math.round;
  const state = { remainingMaximized: Math.max(0, Number(healthConfig.maximized) || 0) };
  let gestalt = 0;

  // PF1e processes racial hit dice before ordinary class hit dice. Mythic
  // paths are also fixed and remain additive rather than occupying a slot.
  const fixed = classes.filter(isFixedClass).sort((a, b) => {
    const priority = (item) => getClassSubtype(item) === "racial" ? 0 : 1;
    return priority(a) - priority(b) || (Number(a.sort) || 0) - (Number(b.sort) || 0);
  });
  for (const item of fixed) {
    gestalt += fixedClassHealth(item, healthConfig, actorConfig, state, round);
  }

  const occurrences = new Map();
  for (const row of levels) {
    const main = actor.items.get(row.mainClassId) ?? null;
    const secondary = actor.items.get(row.secondaryClassId) ?? null;
    if (!main && !secondary) continue;
    const mainHealth = levelHealth(main, nextClassLevel(occurrences, main), healthConfig, actorConfig, state, round);
    const secondaryHealth = levelHealth(
      secondary,
      nextClassLevel(occurrences, secondary),
      healthConfig,
      actorConfig,
      state,
      round,
    );
    const selected = selectGestaltLevelHealth(mainHealth, secondaryHealth);
    gestalt += selected.value;
    state.remainingMaximized -= selected.consumesMaximized;
  }

  if (!healthConfig.continuous) gestalt = round(gestalt);
  return { standard, gestalt };
}

function fixedClassHealth(item, healthConfig, actorConfig, state, round) {
  const subtype = getClassSubtype(item);
  const config = subtype === "racial" ? actorConfig.classes.racial : actorConfig.classes.base;
  if (!config.auto) {
    const value = Number(item.system?.hp) || 0;
    return healthConfig.continuous ? value : round(value);
  }
  if (subtype === "mythic") return (Number(item.system?.hd) || 0) * (Number(item.system?.level) || 0);

  let total = 0;
  const count = Math.max(0, Number(item.system?.level) || 0);
  for (let level = 1; level <= count; level++) {
    const result = levelHealth(item, level, healthConfig, actorConfig, state, round);
    total += result.value;
    state.remainingMaximized -= result.maximized;
  }
  return total;
}

function levelHealth(item, classLevel, healthConfig, actorConfig, state, round) {
  if (!item) return { value: 0, favored: 0, maximized: 0 };
  const subtype = getClassSubtype(item);
  const config = subtype === "npc" ? actorConfig.classes.npc : actorConfig.classes.base;
  const totalHitDice = Math.max(0, Number(item.hitDice ?? item.system?.hitDice) || 0);
  const hitDice = classLevelHitDice(item, classLevel);
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
  if (!healthConfig.continuous) ordinary = round(ordinary);
  const value = maximized * die + Math.max(0, hitDice - maximized) * ordinary;
  return { value, favored, maximized };
}

function enhanceGestaltPage(app, element, actor) {
  const navigation = element.querySelector("nav.sheet-navigation[data-group='primary']");
  const body = element.querySelector("section.primary-body");
  if (!navigation || !body || navigation.querySelector("[data-tab='gestalt']")) return;

  const link = document.createElement("a");
  link.className = "item";
  link.dataset.tab = "gestalt";
  link.dataset.group = "primary";
  link.textContent = localize("PF1GESTALT.Tab.Label");

  const page = document.createElement("div");
  page.className = "tab gestalt flexcol pf1-gestalt-page";
  page.dataset.tab = "gestalt";
  page.dataset.group = "primary";
  const groups = document.createElement("ol");
  groups.className = "item-groups-list pf1-gestalt-level-groups";

  const levels = reconcileLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG), actor.itemTypes?.class ?? []);
  const classLevels = new Map();
  const displayedGoodSaveBonuses = new Set();
  if (useFractionalProgression()) {
    for (const item of actor.itemTypes.class.filter(isFixedClass)) {
      for (const save of ["fort", "ref", "will"]) {
        if (item.system?.savingThrows?.[save]?.good === true) displayedGoodSaveBonuses.add(save);
      }
    }
  }
  const displayedProgression = calculateGestaltLevelProgression(levels, {
    getItem: (id) => actor.items.get(id),
    getStats: (item, level) => ({
      ...classLevelStatistics(item, level, false),
      hitDice: classLevelHitDice(item, level),
    }),
  });
  for (const level of levels) {
    groups.append(buildGestaltLevel(
      app,
      actor,
      level,
      classLevels,
      displayedGoodSaveBonuses,
      displayedProgression.rows[level.level - 1],
    ));
  }
  page.append(groups);
  navigation.append(link);
  body.append(page);

  link.addEventListener("click", (event) => {
    event.preventDefault();
    activateGestaltPage(app, navigation, body, link, page);
  });
  for (const item of navigation.querySelectorAll(".item:not([data-tab='gestalt'])")) {
    item.addEventListener("click", () => {
      link.classList.remove("active");
      page.classList.remove("active");
    });
  }
  if (reactivateGestaltTab.delete(app)) activateGestaltPage(app, navigation, body, link, page);
}

function activateGestaltPage(app, navigation, body, link, page) {
  const tabs = app._tabs?.find((controller) => controller.group === "primary");
  if (typeof tabs?.activate === "function") {
    tabs.activate("gestalt");
    return;
  }

  // Compatibility fallback for sheet implementations without a V1 Tabs
  // controller. PF1e v11 normally uses the controller path above.
  for (const item of navigation.querySelectorAll(".item")) item.classList.toggle("active", item === link);
  for (const tab of body.querySelectorAll(".tab[data-group='primary']")) tab.classList.toggle("active", tab === page);
}

function buildGestaltLevel(app, actor, level, classLevels, displayedGoodSaveBonuses, progressionGain) {
  const list = document.createElement("ol");
  list.className = "item-list pf1-gestalt-level-list";
  const header = document.createElement("li");
  header.className = "item-list-header flexrow";
  const title = document.createElement("div");
  title.className = "item-name";
  const heading = document.createElement("h3");
  heading.textContent = game.i18n.format("PF1GESTALT.Level.Label", { level: level.level });
  title.append(heading);
  header.append(title);
  list.append(header);

  const main = actor.items.get(level.mainClassId) ?? null;
  const secondary = actor.items.get(level.secondaryClassId) ?? null;
  const mainLevel = nextClassLevel(classLevels, main);
  const secondaryLevel = nextClassLevel(classLevels, secondary);
  list.append(classLevelRow(app, actor, level.level - 1, TRACK.MAIN, "PF1GESTALT.Track.Main", main, mainLevel));
  list.append(classLevelRow(app, actor, level.level - 1, TRACK.SECONDARY, "PF1GESTALT.Track.Secondary", secondary, secondaryLevel));
  list.append(statisticsRow(
    actor,
    main,
    mainLevel,
    secondary,
    secondaryLevel,
    displayedGoodSaveBonuses,
    progressionGain,
  ));
  return list;
}

function classLevelRow(app, actor, levelIndex, track, labelKey, item, classLevel) {
  const row = document.createElement("li");
  row.className = "item flexrow pf1-gestalt-class-level-row";
  row.draggable = actor.isOwner;
  row.dataset.gestaltLevelIndex = String(levelIndex);
  row.dataset.gestaltTrack = track;
  if (actor.isOwner) activateGestaltDragAndDrop(row, app, actor);
  const name = document.createElement("div");
  name.className = "item-name";
  if (item) {
    const image = document.createElement("div");
    image.className = "item-image";
    image.style.backgroundImage = `url("${CSS.escape(item.img)}")`;
    const heading = document.createElement("h4");
    heading.textContent = item.name;
    name.append(image, heading);
  }
  else {
    const heading = document.createElement("h4");
    heading.textContent = localize("PF1GESTALT.Level.Unassigned");
    name.append(heading);
  }
  const trackCell = document.createElement("div");
  trackCell.className = "item-detail pf1-gestalt-page-track";
  trackCell.textContent = localize(labelKey);
  const classLevelCell = document.createElement("div");
  classLevelCell.className = "item-detail item-feat-level pf1-gestalt-class-level";
  classLevelCell.textContent = item
    ? game.i18n.format("PF1GESTALT.Level.ClassLevel", { level: classLevel })
    : "—";
  row.append(name, trackCell, classLevelCell);
  return row;
}

function activateGestaltDragAndDrop(row, app, actor) {
  row.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    row.classList.add("pf1-gestalt-dragging");
    event.dataTransfer.effectAllowed = "move";
    draggedGestaltSlot = {
      type: "pf1-gestalt-slot",
      index: Number(row.dataset.gestaltLevelIndex),
      track: row.dataset.gestaltTrack,
    };
    event.dataTransfer.setData("text/plain", JSON.stringify(draggedGestaltSlot));
  });
  row.addEventListener("dragend", () => {
    draggedGestaltSlot = null;
    row.classList.remove("pf1-gestalt-dragging");
  });
  row.addEventListener("dragover", (event) => {
    if (draggedGestaltSlot?.track !== row.dataset.gestaltTrack) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    row.classList.add("pf1-gestalt-drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("pf1-gestalt-drop-target"));
  row.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.classList.remove("pf1-gestalt-drop-target");
    let source;
    try {
      source = JSON.parse(event.dataTransfer.getData("text/plain"));
    }
    catch (_error) {
      return;
    }
    if (source?.type !== "pf1-gestalt-slot") return;
    const target = {
      index: Number(row.dataset.gestaltLevelIndex),
      track: row.dataset.gestaltTrack,
    };
    if (source.track !== target.track) return;
    const current = actor.getFlag(MODULE_ID, LEVELS_FLAG);
    await actor.setFlag(MODULE_ID, LEVELS_FLAG, swapLevelAssignments(current, source, target));
    reactivateGestaltTab.add(app);
    renderApp(app);
  });
}

function statisticsRow(
  actor,
  main,
  mainLevel,
  secondary,
  secondaryLevel,
  displayedGoodSaveBonuses,
  progressionGain,
) {
  const mainStats = classLevelStatistics(main, mainLevel, false);
  const secondaryStats = classLevelStatistics(secondary, secondaryLevel, false);
  const mainSkills = classLevelSkillRanks(actor, main, mainLevel);
  const secondarySkills = classLevelSkillRanks(actor, secondary, secondaryLevel);
  const gained = {
    hitDie: formatHitDieGain(mainStats, secondaryStats),
    bab: progressionGain?.bab ?? 0,
    fort: progressionGain?.fort ?? 0,
    ref: progressionGain?.ref ?? 0,
    will: progressionGain?.will ?? 0,
    skills: Math.max(mainSkills.base, secondarySkills.base) + mainSkills.favored + secondarySkills.favored,
  };
  if (useFractionalProgression()) {
    for (const save of ["fort", "ref", "will"]) {
      const hasGoodSave = [main, secondary]
        .filter(Boolean)
        .some((item) => item.system?.savingThrows?.[save]?.good === true);
      if (hasGoodSave && !displayedGoodSaveBonuses.has(save)) {
        gained[save] += fractionalGoodSaveBonus();
        displayedGoodSaveBonuses.add(save);
      }
    }
  }
  const row = document.createElement("li");
  row.className = "item flexrow pf1-gestalt-statistics-row";
  const name = document.createElement("div");
  name.className = "item-name";
  const heading = document.createElement("h4");
  heading.textContent = localize("PF1GESTALT.Level.Statistics");
  name.append(heading);
  row.append(
    name,
    statCell("PF1GESTALT.Level.HitDie", gained.hitDie),
    statCell("PF1.BAB", signed(gained.bab)),
    statCell("PF1.SavingThrowFort", signed(gained.fort)),
    statCell("PF1.SavingThrowRef", signed(gained.ref)),
    statCell("PF1.SavingThrowWill", signed(gained.will)),
    statCell("PF1.SkillRankPlural", signed(gained.skills)),
  );
  return row;
}

function formatHitDieGain(main, secondary) {
  const hitDice = Math.max(Number(main.hitDice) || 0, Number(secondary.hitDice) || 0);
  if (!hitDice) return "—";
  const die = Math.max(
    (Number(main.hitDice) || 0) === hitDice ? Number(main.hd) || 0 : 0,
    (Number(secondary.hitDice) || 0) === hitDice ? Number(secondary.hd) || 0 : 0,
  );
  if (!die) return String(hitDice);
  return `${hitDice > 1 ? hitDice : ""}d${die}`;
}

function classLevelSkillRanks(actor, item, classLevel) {
  if (!item || !classLevel) return { base: 0, favored: 0 };
  const intelligence = actor.system.abilities?.int;
  const favored = (Number(item.system?.fc?.skill?.value) || 0) >= classLevel ? 1 : 0;
  if (intelligence?.value === null) return { base: 0, favored };
  const base = Math.max(1, (Number(item.system?.skillsPerLevel) || 0) + (Number(intelligence?.mod) || 0))
    * classLevelHitDice(item, classLevel);
  return { base, favored };
}

function classLevelStatistics(item, level, includeFractionalGoodBonus = true) {
  if (!item || !level) return { hd: 0, hitDice: 0, bab: 0, fort: 0, ref: 0, will: 0 };
  const fractional = useFractionalProgression();
  const result = {
    hd: Number(item.system.hd) || 0,
    hitDice: classLevelHitDice(item, level),
    bab: cumulativeBAB(item, level, fractional) - cumulativeBAB(item, level - 1, fractional),
    babRank: progressionRank(item.system.bab, { low: 1, med: 2, high: 3 }),
  };
  for (const save of ["fort", "ref", "will"]) {
    const progression = item.system.savingThrows?.[save]?.value;
    result[save] = cumulativeSave(item, save, level, fractional) - cumulativeSave(item, save, level - 1, fractional);
    result[`${save}Rank`] = progressionRank(progression, { low: 1, high: 2 });
    if (
      fractional
      && includeFractionalGoodBonus
      && level === 1
      && progression === "high"
    ) result[save] += fractionalGoodSaveBonus();
  }
  return result;
}

function progressionRank(value, ranks) {
  return Object.hasOwn(ranks, value) ? ranks[value] : null;
}

function cumulativeBAB(item, level, fractional) {
  if (level <= 0) return 0;
  const type = item.system.bab;
  const formulas = fractional ? pf1.config.classFractionalBABFormulas : pf1.config.classBABFormulas;
  const formula = type === "custom" ? item.system.babFormula || "0" : formulas[type] || "0";
  return evaluateClassFormula(formula, level, cumulativeClassHitDice(item, level));
}

function cumulativeSave(item, save, level, fractional) {
  if (level <= 0) return 0;
  const saveData = item.system.savingThrows?.[save];
  const subtype = item.subType ?? item.system.subType ?? "base";
  const formulas = fractional ? pf1.config.classFractionalSavingThrowFormulas : pf1.config.classSavingThrowFormulas;
  const formula = saveData?.value === "custom" ? saveData.custom || "0" : formulas[subtype]?.[saveData?.value] || "0";
  return evaluateClassFormula(formula, level, cumulativeClassHitDice(item, level));
}

function evaluateClassFormula(formula, level, hitDice = level) {
  return Number(pf1.dice.RollPF.safeRollSync(formula, { level, hitDice }).total) || 0;
}

function cumulativeClassHitDice(item, level) {
  if (!item || level <= 0 || getClassSubtype(item) === "mythic") return 0;
  const formula = item.system?.customHD;
  if (typeof formula === "string" && formula.trim()) {
    const result = pf1.dice.RollPF.safeRollSync(formula, { item: { level } }).total;
    return Math.max(0, Number(result) || 0);
  }
  return level;
}

function classLevelHitDice(item, level) {
  if (!item || level <= 0) return 0;
  return Math.max(0, cumulativeClassHitDice(item, level) - cumulativeClassHitDice(item, level - 1));
}

function nextClassLevel(levels, item) {
  if (!item) return 0;
  const level = (levels.get(item.id) ?? 0) + 1;
  levels.set(item.id, level);
  return level;
}

function statCell(labelKey, value) {
  const cell = document.createElement("div");
  cell.className = "item-detail pf1-gestalt-stat-cell";
  cell.dataset.tooltip = labelKey;
  cell.textContent = value;
  return cell;
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${Number.isInteger(number) ? number : number.toFixed(2)}`;
}

function buildSummary(main, secondary, fixed) {
  const summary = document.createElement("div");
  summary.className = "pf1-gestalt-summary";
  summary.append(
    summaryTrack("PF1GESTALT.Track.Main", main),
    summaryTrack("PF1GESTALT.Track.Secondary", secondary),
  );
  if (fixed.length) summary.append(summaryTrack("PF1GESTALT.Track.Fixed", fixed));
  return summary;
}

function summaryTrack(labelKey, items) {
  const container = document.createElement("div");
  const heading = document.createElement("strong");
  const names = document.createElement("span");
  heading.textContent = localize(labelKey);
  names.textContent = classNames(items);
  container.append(heading, names);
  return container;
}

function classNames(items) {
  return items.length ? items.map((item) => `${item.name} ${item.system.level}`).join(", ") : "—";
}

function option(value, label, selected) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  element.selected = value === selected;
  return element;
}

function insertTrackDetails(row, details) {
  const levelCell = row.querySelector(".item-feat-level");
  (levelCell ?? row.querySelector(".item-controls"))?.before(details);
}

function rootElement(html, app) {
  if (html?.querySelector) return html;
  if (html?.[0]?.querySelector) return html[0];
  if (app.element?.querySelector) return app.element;
  if (app.element?.[0]?.querySelector) return app.element[0];
  return null;
}

function renderApp(app) {
  app.render(true);
}

/**
 * Store the selected track and immediately rebuild the actor's per-level
 * gestalt rows. This keeps the Gestalt tab derived from the same selection
 * displayed on the Summary page.
 */
async function updateClassTrack(item, track) {
  await item.update({ [FLAG_PATH]: track }, { pf1GestaltSkipSync: true });
  const actor = item.parent;
  if (actor?.type !== "character") return;
  await synchronizeLevelArray(actor);
}

async function synchronizeLevelArray(actor, { preserveOrder = false } = {}) {
  const classes = actor.itemTypes?.class ?? [];
  const levels = preserveOrder
    ? reconcileLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG), classes)
    : createLevelArray(classes);
  await actor.setFlag(MODULE_ID, LEVELS_FLAG, levels);
}

function localize(key) {
  return game.i18n.localize(key);
}
