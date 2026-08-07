# PF1e Gestalt

A Foundry VTT module for running gestalt characters with the Pathfinder 1e system.

## Current behavior

- Adds a **Gestalt Track** selector to every character class: **Main Class** or **Secondary Class**.
- Existing and unassigned classes default to the main track.
- Displays both tracks on the character summary.
- Counts character level and hit dice only once across the two tracks.
- Stores Main and Secondary class assignments for every gestalt level.
- Uses the better BAB and base-save gain independently at every stored level.
- Uses the better configured HP gain independently at every stored level.
- Allows classes to be rearranged between levels within their own track by dragging them on the Gestalt tab.
- Leaves racial hit dice and mythic paths additive.
- Displays racial hit dice and mythic paths as fixed classes rather than editable gestalt tracks.

Class features, spellcasting, and class items remain available from both tracks because the module does not disable or replace either class item.

## Install for development

Link or copy this directory into Foundry's `Data/modules/pf1-gestalt` directory, enable **PF1e Gestalt** in a PF1 world, and reload the world.

The current manifest targets Foundry VTT 13 and PF1 system 11.x.

The controls appear on the character **Summary** tab immediately above the existing class list. Each class row has a track selector.

## Calculation scope

Version 0.4 calculates level, hit dice, BAB, base saves, class HP, and skill-rank allowances from the level-by-level Gestalt array. At every Gestalt level, BAB uses the higher progression category (full, then 3/4, then 1/2) and each base save uses good over poor, then applies that chosen class level's gain. This remains level-by-level when either track changes classes. Automatic HP follows PF1e's health configuration, including its rounding and maximized-hit-die settings. When class HP is entered manually, PF1e stores only one aggregate value on the class item, so the module distributes that value evenly across that class's stored levels before comparing each gestalt pair. Skill ranks use the better class allowance at each level and include Intelligence, minimum ranks, background skills, and one favored-class bonus per character level.
