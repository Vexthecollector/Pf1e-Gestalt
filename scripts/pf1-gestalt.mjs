import {
  calculateCumulativeHitDice,
  calculateGestaltClassHealth,
  calculateGestaltLevelProgression,
  getStoredTrack,
  getTrack,
  isFixedClass,
  shorterClassTrack,
  TRACK,
} from "./gestalt-calculator.mjs";
import {
  createLevelArray,
  isValidGestaltDrop,
  LEVELS_FLAG,
  normalizeLevelArray,
  reconcileLevelArray,
  swapLevelAssignments,
} from "./gestalt-levels.mjs";
import {
  allowCatchUpFavoredClass,
  getLevelUpSimulacra,
  getLevelUpState,
  isLevelUpReady,
} from "./gestalt-level-up.mjs";
import { calculateGestaltSkillRanks, calculateSkillRankDisplay } from "./gestalt-skills.mjs";
import { isBuiltInClassSource, replaceSourceEntries, updateSourceEntry } from "./gestalt-sources.mjs";

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

Hooks.on("preCreateItem", (item, _data, _options, userId) => {
  if (game.user.id !== userId || item.type !== "class" || item.parent?.type !== "character") return;
  if (isFixedClass(item) || getStoredTrack(item)) return;
  const existing = item.parent.itemTypes?.class?.filter((entry) => entry !== item) ?? [];
  item.updateSource({ [FLAG_PATH]: shorterClassTrack(existing) });
});

// Keep the level array synchronized even when a class track or level is
// changed somewhere other than the injected Summary-page control.
Hooks.on("updateItem", async (item, changes, options, userId) => {
  if (game.user.id !== userId || options?.pf1GestaltSkipSync === true) return;
  if (item.type !== "class" || item.parent?.type !== "character") return;
  const trackChanged = foundry.utils.hasProperty(changes, FLAG_PATH);
  const levelChanged = foundry.utils.hasProperty(changes, "system.level");
  if (trackChanged || levelChanged) await synchronizeLevelArray(item.parent);
});

for (const hook of ["createItem", "deleteItem"]) {
  Hooks.on(hook, async (item, _options, userId) => {
    if (game.user.id !== userId || item.type !== "class" || item.parent?.type !== "character") return;
    await synchronizeLevelArray(item.parent);
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

  const baseLabel = localizeCompat("PF1.ModifierType.base", "PF1.Base");
  const goodSaveLabel = localizeCompat("PF1.SavingThrow.GoodBonus", "PF1.SavingThrowGoodFractionalBonus");
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
    formatCompat(
      "PF1.Sources.Class.FCB",
      "PF1.SourceInfoSkillRank_ClassFC",
      { class: item.name, className: item.name },
    )
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

for (const hook of ["renderApplicationV2", "renderActorSheet"]) {
  Hooks.on(hook, enhanceRenderedSheet);
}

Hooks.on("renderLevelUpForm", adjustGestaltLevelUpForm);
Hooks.on("renderPF1ExtendedTooltip", enhanceGestaltExtendedTooltip);

function adjustGestaltLevelUpForm(app, html) {
  const actor = app.actor;
  const item = app.item;
  if (actor?.type !== "character" || item?.type !== "class" || isFixedClass(item)) return;
  const assignedNewClassTrack = assignNewClassTrack(app, actor, item);
  const hasSecondary = getTrack(item) === TRACK.SECONDARY
    || actor.itemTypes.class.some((entry) => !isFixedClass(entry) && getTrack(entry) === TRACK.SECONDARY);
  if (!hasSecondary) return;
  const lowerTrack = shorterClassTrack(actor.itemTypes.class, null);
  const catchUp = lowerTrack && getTrack(item) === lowerTrack;

  const element = rootElement(html, app);
  const config = getLevelUpState(app);
  if (!config) return;
  let rerenderFavoredClass = false;
  if (catchUp) {
    // PF1e looks up ASIs from the preview actor's total HD without checking
    // whether HD actually increased. A catch-up level fills an existing
    // gestalt row, so suppress repeated milestone rewards.
    config.abilityScore.new = 0;
    config.abilityScore.used = 0;
    for (const ability of Object.values(config.abilityScore.upgrades ?? {})) ability.added = 0;
    rerenderFavoredClass = allowCatchUpFavoredClass(app, config);
    replaceLevelUpSegment(
      element,
      ".segment.ability-score",
      "PF1.LevelUp.AbilityScore.Label",
      "PF1GESTALT.LevelUp.CatchUpASI",
    );
  }

  adjustLevelUpSkillRanks(app, config, element);
  const submit = element?.querySelector("button[type='submit'][data-action='commit']");
  if (submit) submit.disabled = !isLevelUpReady(app);
  if (assignedNewClassTrack && typeof app.render === "function") {
    queueMicrotask(() => renderApp(app));
  }
  else if (rerenderFavoredClass && typeof app.render === "function") {
    queueMicrotask(() => app.render({ parts: ["fcb"] }));
  }
}

function assignNewClassTrack(app, actor, item) {
  if (app.isNewClass !== true || getStoredTrack(item)) return false;
  const track = shorterClassTrack(actor.itemTypes?.class ?? []);
  item.updateSource({ [FLAG_PATH]: track });
  const mold = app._mold ?? app.mold;
  mold?.updateSource({ [FLAG_PATH]: track });
  if (typeof app._regenerateDeltas === "function") app._regenerateDeltas();
  else if (typeof app._initData === "function") app._initData();
  return true;
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

function adjustLevelUpSkillRanks(app, config, element) {
  const simulacra = getLevelUpSimulacra(app);
  if (!simulacra || !config.skills) return;
  const oldRanks = actorGestaltSkillRanks(app.actor);
  const newRanks = actorGestaltSkillRanks(simulacra);
  const pendingFavoredRank = config.fcb.choice === "skill" ? 1 : 0;
  const adventureDelta = newRanks.adventure - oldRanks.adventure + pendingFavoredRank;
  const backgroundDelta = newRanks.background - oldRanks.background;
  config.skills.old = { value: oldRanks.adventure, bg: oldRanks.background };
  config.skills.new = { value: newRanks.adventure, bg: newRanks.background };
  config.skills.delta = { adv: adventureDelta, bg: backgroundDelta, ranks: adventureDelta };
  config.level.skills = adventureDelta + backgroundDelta;

  const skill = element?.querySelector(".summary .details .skill");
  if (!skill) return;
  skill.classList.toggle("disabled", adventureDelta === 0 && backgroundDelta === 0);
  skill.classList.toggle("inactive", adventureDelta === 0 && backgroundDelta === 0);
  const adventure = skill.querySelector(".adventure .value");
  const background = skill.querySelector(".background .value");
  if (adventure || background) {
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

  // ApplicationV2 guarantees its generic render hook; keep the named hook
  // above for the legacy form and as an idempotent compatibility path.
  if (getLevelUpState(app)?.abilityScore && getLevelUpSimulacra(app)) {
    adjustGestaltLevelUpForm(app, element);
    return;
  }

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
    || !actor.itemTypes.class.some((item) => !isFixedClass(item) && getTrack(item) === TRACK.SECONDARY)
  ) return;

  if (!["skills.adventure", "skills.background"].includes(id)) {
    // PF1e 11.8 exposes mutable sourceInfo and is handled during actor data
    // preparation. PF1e 11.11 builds source details on demand instead.
    if (!actor.sourceInfo) enhanceCurrentGestaltSourceTooltip(actor, id, template);
    return;
  }

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
      if (!value || source.enabled === false || source.disabled) continue;
      entries.push({ name: source.name, value });
      describedBonus += value;
    }
    if (bonus !== describedBonus) {
      entries.push({
        name: localizeCompat("PF1.Skill.Rank.BonusFormula", "PF1.BuffTarBonusSkillRanks"),
        value: bonus - describedBonus,
      });
    }
  }
  if (displayed.transferred) {
    entries.push({
      name: localizeCompat("PF1.Skill.Transferred", "PF1.Transferred"),
      value: id === "skills.background" ? displayed.transferred : -displayed.transferred,
    });
  }
  replaceTooltipSources(template, entries);
}

function enhanceCurrentGestaltSourceTooltip(actor, id, template) {
  const descriptors = {
    bab: { path: "system.attributes.bab.total", stat: "bab" },
    "save.fort": { path: "system.attributes.savingThrows.fort.total", save: "fort" },
    "save.ref": { path: "system.attributes.savingThrows.ref.total", save: "ref" },
    "save.will": { path: "system.attributes.savingThrows.will.total", save: "will" },
    "hit-points": { path: "system.attributes.hp.max", health: "hp" },
    vigor: { path: "system.attributes.vigor.max", health: "vigor" },
  };
  const descriptor = descriptors[id];
  if (!descriptor) return;

  const classes = [...(actor.itemTypes?.class ?? [])];
  const levels = reconcileLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG), classes);
  const result = calculateArrayProgression(actor, classes, levels, useFractionalProgression());
  if (!result.active) return;
  const health = descriptor.health
    ? calculateArrayHealth(actor, classes, levels, game.settings.get("pf1", "healthConfig"))
    : null;
  const classNames = new Set(classes.map((item) => item.name));
  const extraNames = new Set();
  if (descriptor.save) {
    extraNames.add(localizeCompat("PF1.ModifierType.base", "PF1.Base"));
    extraNames.add(localizeCompat("PF1.SavingThrow.GoodBonus", "PF1.SavingThrowGoodFractionalBonus"));
  }
  if (descriptor.health) {
    for (const item of classes) {
      for (const name of formatAlternatives(
        "PF1.Sources.Class.FCB",
        "PF1.SourceInfoSkillRank_ClassFC",
        { class: item.name, className: item.name },
      )) extraNames.add(name);
    }
  }
  let entries = (actor.getSourceDetails(descriptor.path) ?? [])
    .filter((entry) => (
      entry.enabled !== false
      && !entry.disabled
      && !isBuiltInClassSource(entry, { classNames, extraNames })
    ));

  let gestaltValue = 0;
  if (descriptor.stat) gestaltValue = result[descriptor.stat];
  else if (descriptor.save) gestaltValue = result.saves[descriptor.save];
  else gestaltValue = health.gestalt;

  if (descriptor.health === "hp") {
    const hpAbility = actor.system.attributes.hpAbility;
    const abilityLabel = hpAbility ? pf1.config.abilities[hpAbility] : null;
    entries = entries.filter((entry) => !abilityLabel || entry.name !== abilityLabel);
    if (hpAbility) {
      const modifier = Number(actor.system.abilities?.[hpAbility]?.mod) || 0;
      if (modifier) entries.push({ name: abilityLabel, value: modifier * result.hitDice });
    }
  }

  entries.push({ name: localize("PF1GESTALT.Source.GestaltClasses"), value: gestaltValue });
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
    .find((element) => element.textContent.trim() === localizeCompat("PF1.Sources.From", "PF1.FromSources"));
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
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    flavor.append(name);
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
  const lowerTrack = shorterClassTrack(actor.itemTypes.class, null);
  if (!lowerTrack) return;

  for (const item of eligible.filter((entry) => getTrack(entry) === lowerTrack)) {
    const row = classesBody.querySelector(`.item[data-item-id="${CSS.escape(item.id)}"]`);
    const cell = row?.querySelector(".item-button, .context-controls");
    if (!cell || cell.querySelector(".level-up")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "level-up pf1-gestalt-catch-up";
    button.dataset.action = "levelUp";
    button.dataset.itemId = item.id;
    button.textContent = localize("PF1.LevelUp.Action");
    if (typeof app._onLevelUp === "function") {
      button.addEventListener("click", (event) => app._onLevelUp(event));
    }
    cell.append(button);
  }
}

function calculateArrayProgression(actor, classes, levels, fractional) {
  const fixed = classes.filter(isFixedClass);
  const totals = calculateGestaltLevelProgression(levels, {
    getItem: (id) => actor.items.get(id),
    getStats: (item, level) => ({
      ...classLevelStatistics(item, level, fractional),
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
  return calculateGestaltClassHealth(classes, levels, healthConfig, {
    actorType: actor.type,
    getItem: (id) => actor.items.get(id),
    getHitDice: classLevelHitDice,
  });
}

function enhanceGestaltPage(app, element, actor) {
  const navigation = element.querySelector("nav.sheet-navigation[data-group='primary']");
  const body = element.querySelector("section.primary-body") ?? navigation?.parentElement;
  if (!navigation || !body) return;

  const oldLink = navigation.querySelector("[data-tab='gestalt']");
  const oldPage = body.querySelector(".pf1-gestalt-page[data-tab='gestalt']");
  const wasActive = oldLink?.classList.contains("active") || oldPage?.classList.contains("active");
  oldLink?.remove();
  oldPage?.remove();

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
  const fractional = useFractionalProgression();
  if (fractional) {
    for (const item of actor.itemTypes.class.filter(isFixedClass)) {
      for (const save of ["fort", "ref", "will"]) {
        if (item.system?.savingThrows?.[save]?.good === true) displayedGoodSaveBonuses.add(save);
      }
    }
  }
  const displayedProgression = calculateGestaltLevelProgression(levels, {
    getItem: (id) => actor.items.get(id),
    getStats: (item, level) => ({
      ...classLevelStatistics(item, level, fractional),
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
      fractional,
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
    if (item.dataset.gestaltTabListener === "true") continue;
    item.dataset.gestaltTabListener = "true";
    item.addEventListener("click", () => {
      navigation.querySelector("[data-tab='gestalt']")?.classList.remove("active");
      body.querySelector(".pf1-gestalt-page[data-tab='gestalt']")?.classList.remove("active");
    });
  }
  if (wasActive || reactivateGestaltTab.delete(app)) activateGestaltPage(app, navigation, body, link, page);
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

function buildGestaltLevel(
  app,
  actor,
  level,
  classLevels,
  displayedGoodSaveBonuses,
  fractional,
  progressionGain,
) {
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
    fractional,
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
      actorId: actor.id,
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
    if (!isValidGestaltDrop(draggedGestaltSlot, {
      actorId: actor.id,
      track: row.dataset.gestaltTrack,
    })) return;
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
    const target = {
      actorId: actor.id,
      index: Number(row.dataset.gestaltLevelIndex),
      track: row.dataset.gestaltTrack,
    };
    if (!isValidGestaltDrop(source, target)) return;
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
  fractional,
  progressionGain,
) {
  const mainStats = classLevelStatistics(main, mainLevel, fractional);
  const secondaryStats = classLevelStatistics(secondary, secondaryLevel, fractional);
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
  if (fractional) {
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
    statCell(compatibleKey("PF1.BAB.Label", "PF1.BAB"), signed(gained.bab)),
    statCell(compatibleKey("PF1.SavingThrow.fort", "PF1.SavingThrowFort"), signed(gained.fort)),
    statCell(compatibleKey("PF1.SavingThrow.ref", "PF1.SavingThrowRef"), signed(gained.ref)),
    statCell(compatibleKey("PF1.SavingThrow.will", "PF1.SavingThrowWill"), signed(gained.will)),
    statCell(compatibleKey("PF1.Skill.Rank.many", "PF1.SkillRankPlural"), signed(gained.skills)),
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

function classLevelStatistics(item, level, fractional) {
  if (!item || !level) return { hd: 0, hitDice: 0, bab: 0, fort: 0, ref: 0, will: 0 };
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
  return calculateCumulativeHitDice(item, level, {
    progressions: pf1.config.hitDieProgression,
    evaluateFormula: (formula, data) => pf1.dice.RollPF.safeRollSync(formula, data).total,
  });
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
  app.render();
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

async function synchronizeLevelArray(actor) {
  const classes = actor.itemTypes?.class ?? [];
  const levels = reconcileLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG), classes);
  await actor.setFlag(MODULE_ID, LEVELS_FLAG, levels);
}

function localize(key) {
  return game.i18n.localize(key);
}

function compatibleKey(modern, legacy) {
  return typeof game.i18n.has === "function" && game.i18n.has(modern) ? modern : legacy;
}

function localizeCompat(modern, legacy) {
  return localize(compatibleKey(modern, legacy));
}

function formatCompat(modern, legacy, data) {
  return game.i18n.format(compatibleKey(modern, legacy), data);
}

function formatAlternatives(modern, legacy, data) {
  return new Set([game.i18n.format(modern, data), game.i18n.format(legacy, data)]);
}
