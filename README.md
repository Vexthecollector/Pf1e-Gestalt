# PF1e Gestalt

A Foundry VTT module for running gestalt characters with the Pathfinder 1e system.

## Current behavior

- Adds a **Gestalt Track** selector to every character class: **Main Class** or **Secondary Class**.
- Existing and unassigned classes default to the main track.
- Displays both tracks on the character summary.
- Counts character level and hit dice only once across the two tracks.
- Uses the better aggregate BAB and base save progression from the two tracks.
- Uses the higher class HP contribution of the two tracks instead of adding both.
- Leaves racial hit dice and mythic paths additive.
- Displays racial hit dice and mythic paths as fixed classes rather than editable gestalt tracks.

Class features, spellcasting, and class items remain available from both tracks because the module does not disable or replace either class item.

## Install for development

Link or copy this directory into Foundry's `Data/modules/pf1-gestalt` directory, enable **PF1e Gestalt** in a PF1 world, and reload the world.

The current manifest targets Foundry VTT 13 and PF1 system 11.x.

The controls appear on the character **Summary** tab immediately above the existing class list. Each class row has a track selector. The selector also appears at the top of an opened class-item sheet.

## Calculation scope

Version 0.2 uses the better aggregate progression of the two tracks. Exact level-by-level pairing—needed when a track multiclasses between progression types—will require a later level-history editor. Skill-rank allowances are not overridden yet.
