#!/usr/bin/env python3
"""
BSData → Grimoire converter (v2)

Converts BattleScribe .cat army data from BSData/age-of-sigmar-4th into JSON
for the Muster Roll web app's Grimoire import.

v2 additions:
  - Extracts unit categories (HERO, INFANTRY, MONSTER, etc.)
  - Marks isHero / canReinforce per unit
  - Extracts faction-level enhancements (artefacts, heroic traits, battle
    formations, boons, battle traits, spell lores, prayer lores)
  - Outputs two files per faction:
      output/<Faction>.json         — units (backward-compatible)
      output/<Faction>.rules.json   — army rules & enhancements
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

BS_NS = {'bs': 'http://www.battlescribe.net/schema/catalogueSchema'}
GST_NS = {'bs': 'http://www.battlescribe.net/schema/gameSystemSchema'}

# ── Category IDs we care about ──────────────────────────────────────────────
HERO_CAT_ID = '6e72-1656-d554-528a'
UNIQUE_CAT_ID = '72ce-2188-70bf-2dbd'
MONSTER_CAT_ID = '6d54-625c-d063-13e2'
WAR_MACHINE_CAT_ID = 'f7bc-b618-4b5d-2bae'
CAVALRY_CAT_ID = '926c-df8c-6841-d49e'
INFANTRY_CAT_ID = '75d6-6995-dfcc-3898'
BEAST_CAT_ID = 'b224-8c8e-ca93-9860'
FLY_CAT_ID = 'b979-4c3e-7d0e-6921'

ROLE_CATS = {
    HERO_CAT_ID: 'hero',
    MONSTER_CAT_ID: 'monster',
    WAR_MACHINE_CAT_ID: 'war_machine',
    CAVALRY_CAT_ID: 'cavalry',
    INFANTRY_CAT_ID: 'infantry',
    BEAST_CAT_ID: 'beast',
}

# Skip these categories when building the unit's keyword list
SKIP_CATS = {
    'Restrict General', 'Reference', 'Configuration', 'Army Composition',
    'Enhancement Configuration', 'Order of Battle', 'Arcane Tome',
    'Command Model', 'Undersize Unit', 'Legends',
    'Regimental Leader', 'Regimental Option', 'Regimental Hero',
}
SKIP_CAT_IDS = {
    'abcb-73d0-2b6c-4f17',  # Restrict General
    '3360-1158-e879-9606',  # Reference
    '676-2b78-7bbf-ba9c',   # Configuration
    'ac97-b27c-7e35-7ab9',  # Army Composition
    '8aac-5207-b454-5ecb',  # Enhancement Configuration
    '8e18-320c-b5bb-7cc6',  # Order of Battle
    '707c-1c04-9af6-2307',  # Arcane Tome
    '9c77-5e0b-a20f-d885',  # Command Model
    'c461-2ebb-5bbc-81a2',  # Undersize Unit
    'acaf-8bb6-d6f-3e2a',   # Legends
    'd1f3-921c-b403-1106',  # Regimental Leader
    'db3a-7199-c92e-f3cf',  # Regimental Option
    '8f4b-1fa6-3128-8405',  # Regimental Hero
}


def clean_text(s):
    """Strip BattleScribe markup (**bold**, ^^keywords^^) and normalize whitespace."""
    if not s:
        return ''
    s = re.sub(r'\*\*','', s)
    s = re.sub(r'\^\^','', s)
    s = s.replace('&apos;', "'").replace('&quot;', '"').replace('&amp;', '&')
    s = s.replace('&lt;', '<').replace('&gt;', '>')
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip()


def get_cost(elem):
    """Extract points cost from a costs element."""
    for cost in elem.findall('.//bs:cost', BS_NS):
        if cost.get('name', '').lower() == 'pts':
            return int(float(cost.get('value', 0)))
    return 0


def get_categories(elem, cat_map):
    """Get category names for an element, filtered to useful ones."""
    cats = []
    for cl in elem.findall('.//bs:categoryLink', BS_NS):
        cid = cl.get('targetId', '')
        cname = cl.get('name', '') or cat_map.get(cid, '')
        # Skip negative categories (non-X)
        if cname.startswith('non-'):
            continue
        if cname and cname not in SKIP_CATS and cid not in SKIP_CAT_IDS:
            cats.append(cname)
    return cats


def has_hero_categories(cats):
    """Check if category list includes HERO."""
    return 'HERO' in cats


def can_reinforce(entry_link):
    """Check if a unit entry link has the Reinforced option."""
    for el in entry_link.findall('.//bs:entryLink', BS_NS):
        if el.get('name', '') == 'Reinforced':
            return True
    return False


def get_enhancement_types(entry_link):
    """Determine which enhancement types a unit can accept."""
    types = set()
    for el in entry_link.findall('.//bs:entryLink', BS_NS):
        name = el.get('name', '')
        if name == 'Heroic Traits':
            types.add('heroicTraits')
        elif name == 'Artefacts of Power':
            types.add('artefacts')
        elif 'Boon' in name:
            types.add('boons')
        elif name == 'Warlord':
            types.add('warlord')
    return sorted(types)


def parse_profile_characteristics(profile):
    """Parse characteristics from a profile element into a dict."""
    chars = {}
    for c in profile.findall('bs:characteristics/bs:characteristic', BS_NS):
        name = c.get('name', '')
        val = clean_text(c.text or '')
        chars[name] = val
    return chars


def extract_weapon_profiles(entry):
    """Extract all melee/ranged weapon profiles from a selection entry."""
    weapons = []
    for prof in entry.findall('.//bs:profile', BS_NS):
        ptype = prof.get('typeName', '')
        if 'Weapon' not in ptype:
            continue
        chars = parse_profile_characteristics(prof)
        weapons.append({
            'name': prof.get('name', ''),
            'models': '',
            'attacks': chars.get('Atk', chars.get('Attacks', '1')),
            'hit': chars.get('Hit', '').replace('+', ''),
            'wound': chars.get('Wnd', chars.get('Wound', '')).replace('+', ''),
            'rend': chars.get('Rnd', chars.get('Rend', '0')),
            'damage': chars.get('Dmg', chars.get('Damage', '1')),
        })
    return weapons


def extract_abilities(entry):
    """Extract ability profiles as text."""
    lines = []
    for prof in entry.findall('.//bs:profile', BS_NS):
        ptype = prof.get('typeName', '')
        if 'Ability' not in ptype:
            continue
        name = prof.get('name', '')
        chars = parse_profile_characteristics(prof)
        parts = []
        timing = chars.get('Timing', '')
        declare = chars.get('Declare', '')
        effect = chars.get('Effect', '')
        keywords = chars.get('Keywords', '')
        
        if timing:
            parts.append(f'{timing}')
        if declare:
            parts.append(declare)
        if effect:
            parts.append(effect)
        text = f'{name}: ' + ' '.join(parts) if parts else name
        if keywords:
            text += f'\nKeywords: {keywords}'
        lines.append(clean_text(text))
    return '\n'.join(lines) if lines else ''


def extract_unit_profile(entry):
    """Extract Move, Health (wounds), Save from the Unit profile."""
    move = ''
    wounds = 1
    save = ''
    for prof in entry.findall('.//bs:profile', BS_NS):
        if prof.get('typeName', '') != 'Unit':
            continue
        chars = parse_profile_characteristics(prof)
        move = chars.get('Move', '')
        health = chars.get('Health', '')
        try:
            wounds = int(re.search(r'\d+', health).group()) if health else 1
        except (AttributeError, ValueError):
            wounds = 1
        save = chars.get('Save', '').replace('+', '')
        try:
            save = int(re.search(r'\d+', save).group()) if save else ''
        except (AttributeError, ValueError):
            pass
    return move, wounds, save


def extract_model_count(entry):
    """Extract base model count from min constraint with scope=parent.
    Constraints may be on the unit itself or on nested child selectionEntries."""
    # Check direct constraints first
    for c in entry.findall('bs:constraints/bs:constraint', BS_NS):
        if c.get('type') == 'min' and c.get('field') == 'selections' and c.get('scope') == 'parent':
            v = int(c.get('value', '0'))
            if v > 1:
                return v
    # Check nested child selectionEntries
    for sub in entry.findall('bs:selectionEntries/bs:selectionEntry', BS_NS):
        for c in sub.findall('bs:constraints/bs:constraint', BS_NS):
            if c.get('type') == 'min' and c.get('field') == 'selections' and c.get('scope') == 'parent':
                v = int(c.get('value', '0'))
                if v > 1:
                    return v
    return 1


def extract_ward(cats):
    """Extract ward value from category list."""
    for cat in cats:
        m = re.match(r'WARD \((\d+)\+\)', cat)
        if m:
            return int(m.group(1))
    return 0


def extract_enhancement_entry(sel_entry):
    """Extract a single enhancement (artefact, heroic trait, etc.) from a selectionEntry."""
    name = sel_entry.get('name', '')
    cost = get_cost(sel_entry)
    
    # Collect all profiles
    abilities = []
    for prof in sel_entry.findall('.//bs:profile', BS_NS):
        pname = prof.get('name', '')
        ptype = prof.get('typeName', '')
        chars = parse_profile_characteristics(prof)
        
        timing = chars.get('Timing', '')
        declare = chars.get('Declare', '')
        effect = chars.get('Effect', '')
        keywords = chars.get('Keywords', '')
        
        parts = []
        if timing:
            parts.append(timing)
        if declare:
            parts.append(declare)
        if effect:
            parts.append(effect)
        text = f'{pname}'
        if parts:
            text += ': ' + ' '.join(parts)
        if keywords:
            text += f'\nKeywords: {keywords}'
        abilities.append(clean_text(text))
    
    # Get restrictions
    restrictions = []
    for rule in sel_entry.findall('.//bs:rule', BS_NS):
        rname = rule.get('name', '')
        rdesc = clean_text(rule.find('bs:description', BS_NS).text if rule.find('bs:description', BS_NS) is not None else '')
        if rname == 'Enhancement Restrictions' and rdesc:
            restrictions.append(rdesc)
    
    return {
        'name': name,
        'cost': cost,
        'effect': clean_text('\n'.join(abilities)),
        'restrictions': restrictions,
    }


def extract_enhancement_group(group_elem, depth=0):
    """Recursively extract enhancements from a selectionEntryGroup."""
    results = []
    if depth > 5:
        return results
    
    for sel in group_elem.findall('bs:selectionEntries/bs:selectionEntry', BS_NS):
        entry = extract_enhancement_entry(sel)
        entry['groupName'] = group_elem.get('name', '')
        results.append(entry)
    
    for sub in group_elem.findall('bs:selectionEntryGroups/bs:selectionEntryGroup', BS_NS):
        results.extend(extract_enhancement_group(sub, depth + 1))
    
    return results


def extract_faction_rules(root, faction_name):
    """Extract army-wide rules and enhancements from the main .cat file."""
    rules = {
        'faction': faction_name,
        'battleTraits': [],
        'artefacts': [],
        'heroicTraits': [],
        'battleFormations': [],
        'boons': [],
        'spellLores': [],
        'prayerLores': [],
    }
    
    # Battle Traits from sharedSelectionEntries
    for sel in root.findall('.//bs:sharedSelectionEntries/bs:selectionEntry', BS_NS):
        name = sel.get('name', '')
        if 'Battle Traits' in name:
            for prof in sel.findall('.//bs:profile', BS_NS):
                pname = prof.get('name', '')
                chars = parse_profile_characteristics(prof)
                effect = chars.get('Effect', '')
                timing = chars.get('Timing', '')
                text = pname
                if timing:
                    text += f' ({timing})'
                if effect:
                    text += f': {effect}'
                rules['battleTraits'].append({
                    'name': pname,
                    'effect': clean_text(text),
                })
    
    # Enhancement groups from sharedSelectionEntryGroups
    for group in root.findall('.//bs:sharedSelectionEntryGroups/bs:selectionEntryGroup', BS_NS):
        gname = group.get('name', '')
        
        if 'Artefact' in gname:
            rules['artefacts'].extend(extract_enhancement_group(group))
        elif 'Heroic Trait' in gname:
            rules['heroicTraits'].extend(extract_enhancement_group(group))
        elif 'Battle Formation' in gname:
            rules['battleFormations'].extend(extract_enhancement_group(group))
        elif 'Boon' in gname:
            rules['boons'].extend(extract_enhancement_group(group))
        elif 'Spell Lore' in gname:
            for sel in group.findall('.//bs:selectionEntries/bs:selectionEntry', BS_NS):
                lore_name = sel.get('name', '')
                rules['spellLores'].append({'name': lore_name, 'effect': ''})
        elif 'Prayer Lore' in gname:
            for sel in group.findall('.//bs:selectionEntries/bs:selectionEntry', BS_NS):
                lore_name = sel.get('name', '')
                rules['prayerLores'].append({'name': lore_name, 'effect': ''})
    
    return rules


def load_category_map(bsdata_dir):
    """Load category ID → name mapping from the game system .gst file."""
    cat_map = {}
    gst_path = None
    for f in os.listdir(bsdata_dir):
        if f.endswith('.gst'):
            gst_path = os.path.join(bsdata_dir, f)
            break
    if not gst_path:
        return cat_map
    
    tree = ET.parse(gst_path)
    root = tree.getroot()
    ns = {'bs': 'http://www.battlescribe.net/schema/gameSystemSchema'}
    for cat in root.findall('.//bs:categoryEntry', ns):
        cat_map[cat.get('id', '')] = cat.get('name', '')
    return cat_map


def find_library_cat(bsdata_dir, faction_name):
    """Find the Library .cat file for a faction."""
    lib_name = f'{faction_name} - Library.cat'
    lib_path = os.path.join(bsdata_dir, lib_name)
    if os.path.exists(lib_path):
        return lib_path
    # Try variations
    for f in os.listdir(bsdata_dir):
        if f.endswith('.cat') and 'Library' in f and faction_name.lower() in f.lower():
            return os.path.join(bsdata_dir, f)
    return None


def convert_faction(bsdata_dir, faction_name, cat_map, output_name=None):
    """Convert a single faction's .cat files to Grimoire JSON."""
    # Use output_name for faction field in units, fallback to cat name
    faction_label = output_name or faction_name
    main_cat = os.path.join(bsdata_dir, f'{faction_name}.cat')
    if not os.path.exists(main_cat):
        print(f'  ERROR: {main_cat} not found')
        return None, None
    
    # Parse main faction .cat
    tree = ET.parse(main_cat)
    root = tree.getroot()
    
    # Parse Library .cat for unit definitions
    lib_path = find_library_cat(bsdata_dir, faction_name)
    lib_entries = {}  # id → selectionEntry
    if lib_path:
        lib_tree = ET.parse(lib_path)
        lib_root = lib_tree.getroot()
        for sel in lib_root.findall('.//bs:sharedSelectionEntries/bs:selectionEntry', BS_NS):
            lib_entries[sel.get('id', '')] = sel
    
    # Also check sharedSelectionEntries in the main .cat
    for sel in root.findall('.//bs:sharedSelectionEntries/bs:selectionEntry', BS_NS):
        lib_entries[sel.get('id', '')] = sel
    
    units = []
    
    # Process entryLinks at the root level — these are the unit roster entries
    for el in root.findall('bs:entryLinks/bs:entryLink', BS_NS):
        target_id = el.get('targetId', '')
        name = el.get('name', '')
        points = get_cost(el)
        can_reinf = can_reinforce(el)
        enh_types = get_enhancement_types(el)
        
        # Get categories from the entry link itself
        cats = get_categories(el, cat_map)
        
        # Also get categories from the library definition
        lib_entry = lib_entries.get(target_id)
        if lib_entry is not None:
            lib_cats = get_categories(lib_entry, cat_map)
            # Merge, avoiding duplicates
            for c in lib_cats:
                if c not in cats:
                    cats.append(c)
        
        is_hero = has_hero_categories(cats)
        ward = extract_ward(cats)
        
        # Extract stats from library definition
        move = ''
        wounds = 1
        save = ''
        weapons = []
        abilities = ''
        
        if lib_entry is not None:
            move, wounds, save = extract_unit_profile(lib_entry)
            weapons = extract_weapon_profiles(lib_entry)
            abilities = extract_abilities(lib_entry)
        
        # Determine models from the Library definition's min constraint
        models = 1
        if lib_entry is not None:
            models = extract_model_count(lib_entry)
        
        unit = {
            'name': name,
            'faction': faction_label,
            'points': points,
            'models': models,
            'move': move,
            'wounds': wounds,
            'save': save,
            'ward': ward,
            'weapons': weapons,
            'abilities': abilities,
            # New v2 fields:
            'categories': cats,
            'isHero': is_hero,
            'canReinforce': can_reinf,
            'enhancementTypes': enh_types,
        }
        units.append(unit)
    
    # Extract faction rules
    rules = extract_faction_rules(root, faction_label)
    
    return units, rules


def main():
    bsdata_dir = os.path.dirname(os.path.abspath(__file__))
    # If running from a different directory, look for the BSData repo
    if not os.path.exists(os.path.join(bsdata_dir, 'Age of Sigmar 4.0.gst')):
        # Try sibling directory
        candidate = os.path.join(os.path.dirname(bsdata_dir), 'age-of-sigmar-4th')
        if os.path.exists(os.path.join(candidate, 'Age of Sigmar 4.0.gst')):
            bsdata_dir = candidate
        else:
            # Search common locations
            for loc in ['/home/user/workspace/age-of-sigmar-4th', '../age-of-sigmar-4th']:
                if os.path.exists(os.path.join(loc, 'Age of Sigmar 4.0.gst')):
                    bsdata_dir = loc
                    break
    
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output')
    os.makedirs(output_dir, exist_ok=True)
    
    cat_map = load_category_map(bsdata_dir)
    print(f'Loaded {len(cat_map)} categories from game system')
    
    if '--all' in sys.argv:
        # Find all main faction .cat files (no " - " in name, not Library)
        # Skip legacy/discontinued factions and non-faction files
        SKIP_FACTIONS = {
            'Beasts of Chaos',       # discontinued in 4th ed
            'Bonesplitterz',         # merged into Orruk Warclans
            'Ironjawz',              # merged into Orruk Warclans
            'Kruleboyz',             # merged into Orruk Warclans
            'Helsmiths of Hashut',   # legacy/ unofficial
            'Legions of Nagash [LEGENDS]',
            'The Duardin Ascendant [LEGENDS]',
            'Lores',                 # not a faction
            'Path to Glory',         # not a faction
            'Regiments of Renown',   # not a faction
        }
        # Rename factions: BSData name → 4th edition name
        RENAME_FACTIONS = {
            'Big Waaagh!': 'Orruk Warclans',
        }
        factions = []
        for f in sorted(os.listdir(bsdata_dir)):
            if f.endswith('.cat') and ' - ' not in f.replace('.cat', '') and 'Library' not in f:
                name = f.replace('.cat', '')
                if name in SKIP_FACTIONS:
                    print(f'  Skipping legacy/non-faction: {name}')
                    continue
                # Apply rename
                output_name = RENAME_FACTIONS.get(name, name)
                factions.append(output_name)
                if output_name != name:
                    print(f'  Renaming: {name} → {output_name}')
    else:
        factions = [a for a in sys.argv[1:] if not a.startswith('-')]
    
    if not factions:
        print('Usage: python3 bsdata_to_grimoire.py "Faction Name" [...] | --all')
        sys.exit(1)
    
    total_units = 0
    total_rules = 0
    for faction in factions:
        # Check if this is a renamed faction and find the original .cat name
        cat_name = faction
        for orig, renamed in RENAME_FACTIONS.items():
            if faction == renamed:
                cat_name = orig
                break
        print(f'\nConverting: {cat_name}' + (f' (output: {faction})' if cat_name != faction else ''))
        units, rules = convert_faction(bsdata_dir, cat_name, cat_map, output_name=faction if cat_name != faction else None)
        if units is None:
            continue
        
        # Write units JSON
        unit_path = os.path.join(output_dir, f'{faction}.json')
        with open(unit_path, 'w', encoding='utf-8') as f:
            json.dump(units, f, indent=2, ensure_ascii=False)
        print(f'  {len(units)} units → {unit_path}')
        total_units += len(units)
        
        # Write rules JSON
        if rules:
            rules_path = os.path.join(output_dir, f'{faction}.rules.json')
            with open(rules_path, 'w', encoding='utf-8') as f:
                json.dump(rules, f, indent=2, ensure_ascii=False)
            n = sum(len(v) if isinstance(v, list) else 0 for v in rules.values() if isinstance(v, list))
            print(f'  {n} enhancement entries → {rules_path}')
            total_rules += n
    
    print(f'\nDone: {total_units} units, {total_rules} enhancement entries across {len(factions)} factions.')


if __name__ == '__main__':
    main()
