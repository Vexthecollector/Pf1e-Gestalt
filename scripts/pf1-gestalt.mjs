import {
  calculateClassHealth,
  calculateGestaltLevelProgression,
  getClassSubtype,
  getTrack,
  isFixedClass,
  TRACK,
} from "./gestalt-calculator.mjs";
import {
  createLevelArray,
  LEVELS_FLAG,
  normalizeLevelArray,
  reconcileLevelArray,
  swapLevelAssignments,
} from "./gestalt-levels.mjs";

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

Hooks.on("createActor", async (actor) => {
  if (game.user.isGM && actor.type === "character") await ensureLevelArray(actor);
});

// Keep the level array synchronized even when a class track or level is
// changed somewhere other than the injected Summary-page control.
Hooks.on("updateItem", async (item, changes) => {
  if (item.type !== "class" || item.parent?.type !== "character") return;
  const trackChanged = foundry.utils.hasProperty(changes, FLAG_PATH);
  const levelChanged = foundry.utils.hasProperty(changes, "system.level");
  if (trackChanged || levelChanged) await synchronizeLevelArray(item.parent, { preserveOrder: levelChanged });
});

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
  "renderItemSheetPF",
  "renderItemSheet",
]) {
  Hooks.on(hook, enhanceRenderedSheet);
}

Hooks.on("renderLevelUpForm", adjustGestaltLevelUpForm);

function adjustGestaltLevelUpForm(app, html) {
  const actor = app.actor;
  const item = app.item;
  if (actor?.type !== "character" || item?.type !== "class" || isFixedClass(item)) return;
  const lowerTrack = lowerGestaltTrack(actor);
  if (!lowerTrack || getTrack(item) !== lowerTrack) return;

  // PF1e looks up ASIs from the preview actor's total HD without checking
  // whether HD actually increased. A catch-up level fills an existing gestalt
  // row, so suppress that repeated milestone reward.
  app.config.abilityScore.new = 0;
  app.config.abilityScore.used = 0;
  for (const ability of Object.values(app.config.abilityScore.upgrades ?? {})) ability.added = 0;

  const element = rootElement(html, app);
  const segment = element?.querySelector(".segment.ability-score");
  if (segment) {
    const heading = document.createElement("h2");
    heading.textContent = localize("PF1.LevelUp.AbilityScore.Label");
    const note = document.createElement("p");
    note.className = "info pf1-gestalt-catch-up-note";
    note.textContent = localize("PF1GESTALT.LevelUp.CatchUpASI");
    segment.replaceChildren(heading, note);
  }
  const submit = element?.querySelector("button[type='submit'][data-action='commit']");
  if (submit && typeof app.isReady === "function") submit.disabled = !app.isReady();
}

function enhanceRenderedSheet(app, html) {
  const element = rootElement(html, app);
  if (!element) return;

  const actor = app.actor ?? (app.document?.documentName === "Actor" ? app.document : null);
  if (actor?.type === "character") enhanceCharacterSheet(app, element, actor);

  const item = app.item ?? (app.document?.documentName === "Item" ? app.document : null);
  if (item?.type === "class" && item.parent?.type === "character") enhanceClassSheet(element, item);
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
      hitDice: 1,
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
    return priority(a) - priority(b);
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
    const selected = mainHealth.value >= secondaryHealth.value ? mainHealth : secondaryHealth;
    gestalt += selected.value;
    if (selected.maximized) state.remainingMaximized -= 1;
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
  const count = Math.max(0, Number(item.hitDice ?? item.system?.hitDice) || 0);
  for (let level = 1; level <= count; level++) {
    const result = levelHealth(item, level, healthConfig, actorConfig, state, round);
    total += result.value;
    if (result.maximized) state.remainingMaximized -= 1;
  }
  return total;
}

function levelHealth(item, _classLevel, healthConfig, actorConfig, state, round) {
  if (!item) return { value: 0, maximized: false };
  const subtype = getClassSubtype(item);
  const config = subtype === "npc" ? actorConfig.classes.npc : actorConfig.classes.base;
  const hitDice = Math.max(1, Number(item.hitDice ?? item.system?.hitDice ?? item.system?.level) || 1);
  const favored = ["base", "prestige", "npc"].includes(subtype)
    ? (Number(item.system?.fc?.hp?.value) || 0) / hitDice
    : 0;

  if (!config.auto) {
    const total = Number(item.system?.hp) || 0;
    return { value: total / hitDice + favored, maximized: false };
  }

  const die = Number(item.system?.hd) || 0;
  const maximized = config.maximized === true && state.remainingMaximized > 0;
  let value = maximized ? die : 1 + (die - 1) * config.rate;
  if (!healthConfig.continuous) value = round(value);
  return { value: value + favored, maximized };
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

  const levels = normalizeLevelArray(actor.getFlag(MODULE_ID, LEVELS_FLAG));
  const classLevels = new Map();
  for (const level of levels) groups.append(buildGestaltLevel(app, actor, level, classLevels));
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

function buildGestaltLevel(app, actor, level, classLevels) {
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
  list.append(statisticsRow(main, mainLevel, secondary, secondaryLevel));
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
  classLevelCell.className = "item-detail item-feat-level";
  classLevelCell.textContent = item
    ? game.i18n.format("PF1GESTALT.Level.ClassLevel", { level: classLevel })
    : "—";
  row.append(name, trackCell, classLevelCell, emptyControls());
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

function statisticsRow(main, mainLevel, secondary, secondaryLevel) {
  const mainStats = classLevelStatistics(main, mainLevel);
  const secondaryStats = classLevelStatistics(secondary, secondaryLevel);
  const gained = {
    hd: Math.max(mainStats.hd, secondaryStats.hd),
    bab: Math.max(mainStats.bab, secondaryStats.bab),
    fort: Math.max(mainStats.fort, secondaryStats.fort),
    ref: Math.max(mainStats.ref, secondaryStats.ref),
    will: Math.max(mainStats.will, secondaryStats.will),
  };
  const row = document.createElement("li");
  row.className = "item flexrow pf1-gestalt-statistics-row";
  const name = document.createElement("div");
  name.className = "item-name";
  const heading = document.createElement("h4");
  heading.textContent = localize("PF1GESTALT.Level.Statistics");
  name.append(heading);
  row.append(
    name,
    statCell("PF1GESTALT.Level.HitDie", gained.hd ? `d${gained.hd}` : "—"),
    statCell("PF1.BAB", signed(gained.bab)),
    statCell("PF1.SavingThrowFort", signed(gained.fort)),
    statCell("PF1.SavingThrowRef", signed(gained.ref)),
    statCell("PF1.SavingThrowWill", signed(gained.will)),
    emptyControls(),
  );
  return row;
}

function classLevelStatistics(item, level, includeFractionalGoodBonus = true) {
  if (!item || !level) return { hd: 0, bab: 0, fort: 0, ref: 0, will: 0 };
  const fractional = useFractionalProgression();
  const result = {
    hd: Number(item.system.hd) || 0,
    bab: cumulativeBAB(item, level, fractional) - cumulativeBAB(item, level - 1, fractional),
  };
  for (const save of ["fort", "ref", "will"]) {
    result[save] = cumulativeSave(item, save, level, fractional) - cumulativeSave(item, save, level - 1, fractional);
    if (
      fractional
      && includeFractionalGoodBonus
      && level === 1
      && item.system.savingThrows?.[save]?.value === "high"
    ) result[save] += fractionalGoodSaveBonus();
  }
  return result;
}

function cumulativeBAB(item, level, fractional) {
  if (level <= 0) return 0;
  const type = item.system.bab;
  const formulas = fractional ? pf1.config.classFractionalBABFormulas : pf1.config.classBABFormulas;
  const formula = type === "custom" ? item.system.babFormula || "0" : formulas[type] || "0";
  return evaluateClassFormula(formula, level);
}

function cumulativeSave(item, save, level, fractional) {
  if (level <= 0) return 0;
  const saveData = item.system.savingThrows?.[save];
  const subtype = item.subType ?? item.system.subType ?? "base";
  const formulas = fractional ? pf1.config.classFractionalSavingThrowFormulas : pf1.config.classSavingThrowFormulas;
  const formula = saveData?.value === "custom" ? saveData.custom || "0" : formulas[subtype]?.[saveData?.value] || "0";
  return evaluateClassFormula(formula, level);
}

function evaluateClassFormula(formula, level) {
  return Number(pf1.dice.RollPF.safeRollSync(formula, { level, hitDice: level }).total) || 0;
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

function emptyControls() {
  const controls = document.createElement("div");
  controls.className = "item-controls";
  return controls;
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${Number.isInteger(number) ? number : number.toFixed(2)}`;
}

function enhanceClassSheet(element, item) {
  const form = element.querySelector("form") ?? element.querySelector(".window-content");
  if (!form || form.querySelector(".pf1-gestalt-class-setting")) return;

  const group = document.createElement("div");
  group.className = "form-group pf1-gestalt-class-setting";
  const label = document.createElement("label");
  label.textContent = localize("PF1GESTALT.Track.Label");
  const fields = document.createElement("div");
  fields.className = "form-fields";
  group.append(label, fields);

  if (isFixedClass(item)) {
    const fixedLabel = document.createElement("span");
    fixedLabel.className = "pf1-gestalt-fixed-label";
    fixedLabel.textContent = localize("PF1GESTALT.Track.Fixed");
    fields.append(fixedLabel);
    form.prepend(group);
    return;
  }

  const select = document.createElement("select");
  select.append(
    option(TRACK.MAIN, localize("PF1GESTALT.Track.Main"), getTrack(item)),
    option(TRACK.SECONDARY, localize("PF1GESTALT.Track.Secondary"), getTrack(item)),
  );
  select.disabled = !item.isOwner;
  select.addEventListener("change", async (event) => {
    await updateClassTrack(item, event.currentTarget.value);
  });
  fields.append(select);
  form.prepend(group);
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
  await item.update({ [FLAG_PATH]: track });
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
