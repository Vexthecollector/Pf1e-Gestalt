# PF1e Gestalt

A Foundry VTT module for running gestalt characters with the Pathfinder First Edition system.

[![Release v0.4.11](https://img.shields.io/badge/release-v0.4.11-blue?logo=github)](https://github.com/Vexthecollector/Pf1e-Gestalt/releases/latest)
![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-13--14-5c2b75)
![PF1e](https://img.shields.io/badge/PF1e-11.x-2f6f8f)

## Install in Foundry VTT

Copy this manifest URL:

```text
https://github.com/Vexthecollector/Pf1e-Gestalt/releases/latest/download/module.json
```

Then:

1. Open Foundry's **Configuration and Setup** screen.
2. Select **Add-on Modules**, then **Install Module**.
3. Paste the URL into the **Manifest URL** field.
4. Select **Install**.
5. Enable **PF1e Gestalt** in your Pathfinder 1e world.

Foundry will use the same manifest URL to find future module updates.

### Requirements

- Foundry VTT 13 or 14.
- Pathfinder First Edition system 11.x.

## Using the module

Open a character sheet after enabling the module. Each ordinary class has a **Gestalt Track** selector on the Summary tab:

- **Main Class**
- **Secondary Class**

Existing classes without an assignment remain on the Main track. A newly added class defaults to the shorter track; a tie defaults to Main.

The character sheet's **Gestalt** tab shows the two class tracks level by level. Drag a class level within its own track to rearrange which classes are paired at each gestalt level. If one track is behind, the module adds catch-up level buttons to eligible classes on that track.

## Features

- Counts character level and hit dice only once across the paired tracks.
- Stores Main and Secondary class assignments for every gestalt level.
- Uses the better BAB progression and base-save progression independently at each level.
- Uses the better configured class-health gain at each level.
- Calculates skill-rank allowances from the better class at each level.
- Applies recorded favored-class HP and skill bonuses from both paired classes.
- Supports standard, custom, animal companion, and eidolon hit-die progressions.
- Keeps racial hit dice and mythic paths additive as fixed classes.
- Integrates gestalt totals into PF1e's **From Sources** tooltips.
- Supports PF1e's level-up workflow, including lower-track catch-up levels.

Class features, spellcasting, and class items remain available from both tracks because the module does not disable or replace either class item.

## Calculation details

BAB uses the higher progression category at each gestalt level: full, then 3/4, then 1/2. Each save independently uses good progression over poor progression. The chosen progression's gain for that class level is applied, including when either track changes classes.

Automatic health follows PF1e's health configuration, including rounding, maximized-hit-die settings, and class-item order. For manually entered class health, PF1e stores one aggregate value on the class item, so the module distributes it over the class's hit dice before comparing each paired level.

Skill ranks use the better class allowance at each level and account for Intelligence, the minimum rank allowance, background skills, and favored-class bonuses. PF1e source tooltips consolidate class-derived HP, BAB, saves, and skill ranks into a **Gestalt Classes** entry while preserving unrelated bonuses.

## Updating or installing manually

For normal updates, use Foundry's **Update** button for the module.

For a manual installation, download the module zip from the [latest GitHub release](https://github.com/Vexthecollector/Pf1e-Gestalt/releases/latest) and extract it as `pf1-gestalt` inside Foundry's `Data/modules` folder. Restart Foundry afterward.

## Problems and suggestions

Please use the [GitHub issue tracker](https://github.com/Vexthecollector/Pf1e-Gestalt/issues) and include your Foundry version, PF1e system version, and the steps needed to reproduce the problem.

## Development

Run the automated regression suite with:

```text
npm test
```

Release tags use the form `v0.4.11`. The GitHub release workflow validates the tag against `module.json`, runs the tests, builds the Foundry package, and publishes both the package and its manifest.
