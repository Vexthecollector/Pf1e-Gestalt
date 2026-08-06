import {
  calculateGestaltHealth,
  calculateGestaltProgression,
  getTrack,
  isFixedClass,
  TRACK,
} from "./gestalt-calculator.mjs";

const MODULE_ID = "pf1-gestalt";
const FLAG_PATH = `flags.${MODULE_ID}.track`;

Hooks.once("init", () => {
  console.info("PF1e Gestalt | Initializing main and secondary class tracks");
});

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
      await item.update({ [FLAG_PATH]: event.currentTarget.value });
      renderApp(app);
    });
    details.append(select);
    insertTrackDetails(row, details);
  }
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
    await item.update({ [FLAG_PATH]: event.currentTarget.value });
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

function localize(key) {
  return game.i18n.localize(key);
}
