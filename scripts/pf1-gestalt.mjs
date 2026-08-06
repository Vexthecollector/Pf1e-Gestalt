import {
  calculateGestaltHealth,
  calculateGestaltProgression,
  getTrack,
  isFixedClass,
  TRACK,
} from "./gestalt-calculator.mjs";
import {
  createLevelArray,
  LEVELS_FLAG,
  normalizeLevelArray,
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
  if (trackChanged || levelChanged) await synchronizeLevelArray(item.parent);
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
  if (!classes.some((item) => getTrack(item) === TRACK.SECONDARY)) return;

  const result = calculateGestaltProgression(classes, {
    fractional: useFractionalProgression(),
  });
  if (!result.active) return;

  const healthConfig = game.settings.get("pf1", "healthConfig");
  const health = calculateGestaltHealth(classes, healthConfig, actor.type);
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

function classLevelStatistics(item, level) {
  if (!item || !level) return { hd: 0, bab: 0, fort: 0, ref: 0, will: 0 };
  const fractional = useFractionalProgression();
  const result = {
    hd: Number(item.system.hd) || 0,
    bab: cumulativeBAB(item, level, fractional) - cumulativeBAB(item, level - 1, fractional),
  };
  for (const save of ["fort", "ref", "will"]) {
    result[save] = cumulativeSave(item, save, level, fractional) - cumulativeSave(item, save, level - 1, fractional);
    if (fractional && level === 1 && item.system.savingThrows?.[save]?.value === "high") result[save] += 2;
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

async function synchronizeLevelArray(actor) {
  await actor.setFlag(MODULE_ID, LEVELS_FLAG, createLevelArray(actor.itemTypes?.class ?? []));
}

function localize(key) {
  return game.i18n.localize(key);
}
