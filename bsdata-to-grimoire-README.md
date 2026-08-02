# BSData → Grimoire converter

Converts official BattleScribe `.cat` army data (from the BSData/age-of-sigmar-4th
GitHub repo) straight into JSON you can paste into Muster Roll's **Grimoire → Import JSON** box.

## What's in this folder

- `bsdata_to_grimoire.py` — the converter script
- `output/*.json` — ready-to-paste results for the six factions you asked about
  (Soulblight Gravelords, Flesh-eater Courts, Hedonites of Slaanesh,
  Daughters of Khaine, Skaven, Gloomspite Gitz) — **257 units total**

## How to use the JSON right now

Open `output/Soulblight Gravelords.json` (or any faction), copy the whole
contents, paste into the Grimoire's "Import JSON" box in Muster Roll, click
Import. Repeat for each faction file. Matching entries (same name + faction)
get updated in place, so it's safe to re-run later after a battletome update.

## How to re-run it yourself / pull other factions later

You need Python 3 (no extra libraries — it only uses the standard library).

```bash
# 1. Get the source data (one-time, or re-run to pick up GW updates)
git clone https://github.com/BSData/age-of-sigmar-4th.git

# 2. Convert one or more factions — names must match the .cat filenames exactly
python3 bsdata_to_grimoire.py "Skaven"
python3 bsdata_to_grimoire.py "Soulblight Gravelords" "Gloomspite Gitz"

# 3. Or just convert every faction in the repo at once
python3 bsdata_to_grimoire.py --all
```

Output lands in `./output/<Faction Name>.json`.

## How it maps BattleScribe data to the Grimoire schema

| Grimoire field | Where it comes from |
|---|---|
| `name`, `faction` | unit's own name / the faction file name |
| `points`, `models` | main faction `.cat` (points) + base unit-size constraint (models) |
| `move`, `wounds`, `save` | the unit's `Unit`-type profile (Move/Health/Save) |
| `ward` | parsed out of the `WARD (X+)` keyword, if the unit has one |
| `attacks`, `hit`, `wound`, `rend`, `damage` | the unit's **first** melee weapon profile (or first ranged weapon if it has no melee option) |
| `abilities` | every ability's name + effect text, plus a note for any *other* weapon options not used as the representative profile, plus the unit's full keyword list |

## Known limitations

- **One representative weapon only.** Clash of Arms only takes a single
  attacks/hit/wound/rend/damage line per unit, so units with multiple wargear
  options (e.g. a champion's alternate weapon, a monster's secondary attack)
  only get their first/base weapon as hard numbers — the rest are listed as
  text under "Other weapon options" in the abilities box so you can still see
  them and hand-adjust if you want to compare a different loadout.
- **Skipped entries:** faction terrain, endless spells/manifestations, and
  the "Anvil of Apotheosis" build-your-own-hero rules aren't normal
  single-unit datasheets, so the script leaves them out rather than
  producing junk data. The console output tells you what got skipped per
  faction.
- **Ability text is long.** GW's full rules text is included verbatim (with
  bold/underline markup stripped) so nothing is lost, but it can be a wall
  of text for units with lots of rules — that's a straight tradeoff against
  hand-trimming everything.
- **0-point entries** are usually free/auto-included things (a faction's
  free terrain piece, a narrative-only avatar form) rather than a bug, but
  worth a glance if one looks off.
- Sub-detachment-only `.cat` files (e.g. "Soulblight Gravelords - Barrow
  Legion.cat") aren't read — only the main battletome file + its Library.
  Nearly everything you'd want is in there; let me know if you hit a unit
  that's missing and I can extend it to pull those in too.

## Adding more factions later

Just grab the faction name exactly as it appears in the repo (matches the
`.cat` filename, minus the extension) and run the script again — e.g. for
Stormcast Eternals: `python3 bsdata_to_grimoire.py "Stormcast Eternals"`.
