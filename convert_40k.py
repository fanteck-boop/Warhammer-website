#!/usr/bin/env python3
"""Convert BSData wh40k-11e JSON files to Grimoire-compatible JSON.

40K 11th edition stats: M, T, Sv, W, LD, OC, InSv
Points: flat per-unit (pts field in costs array)
"""

import json
import os
import sys
import re

SRC_DIR = os.path.join(os.path.dirname(__file__), 'wh40k-11e')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'output_40k')

# Factions to skip (libraries, titanicus, unaligned, or non-faction files)
SKIP_FACTIONS = {
    'Library - Astartes Heresy Legends',
    'Library - Titans',
    'Library - Tyranids',
    'Unaligned Forces',
    'Imperium - Adeptus Titanicus',
    'Chaos - Titanicus Traitoris',
    'Aeldari - Aeldari Library',
    'Chaos - Chaos Daemons Library',
    'Chaos - Chaos Knights Library',
    'Imperium - Astra Militarum - Library',
    'Imperium - Imperial Knights - Library',
}

# Factions with very few units that are supplements to Space Marines
# We'll merge their unique units into Space Marines
SM_SUPPLEMENTS = {
    'Imperium - Imperial Fists',
    'Imperium - Iron Hands',
    'Imperium - Raven Guard',
    'Imperium - Salamanders',
    'Imperium - White Scars',
}

# Rename factions for cleaner display
RENAME_FACTIONS = {
    'Aeldari - Craftworlds': 'Craftworlds',
    'Aeldari - Drukhari': 'Drukhari',
    'Chaos - Chaos Daemons': 'Chaos Daemons',
    'Chaos - Chaos Knights': 'Chaos Knights',
    'Chaos - Chaos Space Marines': 'Chaos Space Marines',
    'Chaos - Death Guard': 'Death Guard',
    'Chaos - Emperor\'s Children': 'Emperor\'s Children',
    'Chaos - Thousand Sons': 'Thousand Sons',
    'Chaos - World Eaters': 'World Eaters',
    'Imperium - Adepta Sororitas': 'Adepta Sororitas',
    'Imperium - Adeptus Custodes': 'Adeptus Custodes',
    'Imperium - Adeptus Mechanicus': 'Adeptus Mechanicus',
    'Imperium - Agents of the Imperium': 'Agents of the Imperium',
    'Imperium - Astra Militarum': 'Astra Militarum',
    'Imperium - Black Templars': 'Black Templars',
    'Imperium - Blood Angels': 'Blood Angels',
    'Imperium - Dark Angels': 'Dark Angels',
    'Imperium - Deathwatch': 'Deathwatch',
    'Imperium - Grey Knights': 'Grey Knights',
    'Imperium - Imperial Knights': 'Imperial Knights',
    'Imperium - Space Marines': 'Space Marines',
    'Imperium - Space Wolves': 'Space Wolves',
    'Imperium - Ultramarines': 'Ultramarines',
}

# Alliance mapping for 40K (different from AoS)
# 40K doesn't use Grand Alliances, but we'll use faction groupings
FACTION_ALLIANCE = {
    'Chaos Space Marines': 'chaos',
    'Death Guard': 'chaos',
    'Emperor\'s Children': 'chaos',
    'Thousand Sons': 'chaos',
    'World Eaters': 'chaos',
    'Chaos Daemons': 'chaos',
    'Chaos Knights': 'chaos',
    'Adepta Sororitas': 'imperium',
    'Adeptus Custodes': 'imperium',
    'Adeptus Mechanicus': 'imperium',
    'Agents of the Imperium': 'imperium',
    'Astra Militarum': 'imperium',
    'Black Templars': 'imperium',
    'Blood Angels': 'imperium',
    'Dark Angels': 'imperium',
    'Deathwatch': 'imperium',
    'Grey Knights': 'imperium',
    'Imperial Knights': 'imperium',
    'Space Marines': 'imperium',
    'Space Wolves': 'imperium',
    'Ultramarines': 'imperium',
    'Craftworlds': 'aeldari',
    'Drukhari': 'aeldari',
    'Genestealer Cults': 'xenos',
    'Leagues of Votann': 'xenos',
    'Necrons': 'xenos',
    'Orks': 'xenos',
    'T\'au Empire': 'xenos',
    'Tyranids': 'xenos',
}

# Role mapping from 40K categories
def get_role(categories):
    """Determine unit role from category links."""
    cat_lower = [c.lower() for c in categories]
    
    # Check for character/hero
    if any('character' in c for c in cat_lower):
        return 'HERO'
    if any('warlord' in c for c in cat_lower):
        return 'HERO'
    
    # Check for vehicle
    if any('vehicle' in c for c in cat_lower):
        return 'WAR MACHINE'
    
    # Check for monster
    if any('monster' in c for c in cat_lower):
        return 'MONSTER'
    
    # Check for cavalry/beast
    if any('cavalry' in c for c in cat_lower) or any('mounted' in c for c in cat_lower):
        return 'CAVALRY'
    if any('beast' in c for c in cat_lower):
        return 'BEAST'
    
    # Check for battleline (infantry)
    if any('battleline' in c for c in cat_lower):
        return 'INFANTRY'
    
    # Default
    if any('infantry' in c for c in cat_lower):
        return 'INFANTRY'
    
    return 'Other'


def extract_stats(profile):
    """Extract 40K stats from a Unit profile."""
    stats = {}
    for c in profile.get('characteristics', []):
        name = c.get('name', '')
        val = c.get('$text', '') or ''
        stats[name] = val
    return stats


def find_unit_profiles(obj, path=''):
    """Recursively find all Unit-type profiles in a selection entry."""
    profiles = []
    if isinstance(obj, dict):
        if obj.get('typeName') == 'Unit':
            profiles.append(obj)
        for k, v in obj.items():
            profiles.extend(find_unit_profiles(v, f'{path}.{k}'))
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            profiles.extend(find_unit_profiles(item, f'{path}[{i}]'))
    return profiles


def extract_abilities(obj):
    """Recursively find all Abilities profiles."""
    abilities = []
    if isinstance(obj, dict):
        if obj.get('typeName') == 'Abilities':
            name = obj.get('name', '')
            desc = ''
            for c in obj.get('characteristics', []):
                if c.get('name') == 'Description':
                    desc = c.get('$text', '') or ''
            if name and desc:
                abilities.append(f'{name}: {desc[:200]}')
        for k, v in obj.items():
            abilities.extend(extract_abilities(v))
    elif isinstance(obj, list):
        for item in obj:
            abilities.extend(extract_abilities(item))
    return abilities


def extract_model_count(entry):
    """Extract model count from constraints."""
    for con in entry.get('constraints', []):
        if con.get('type') == 'min' and con.get('field') == 'selections':
            return int(con.get('value', 1))
    # Check nested
    for sub in entry.get('selectionEntries', []):
        for con in sub.get('constraints', []):
            if con.get('type') == 'min' and con.get('field') == 'selections':
                return int(con.get('value', 1))
    return 1


def get_categories(entry):
    """Extract category names from categoryLinks."""
    cats = []
    for cl in entry.get('categoryLinks', []):
        name = cl.get('name', '')
        if name and not name.startswith('Faction:') and not name.startswith('non-'):
            cats.append(name)
    return cats


def get_points(entry):
    """Extract points value from costs array."""
    for c in entry.get('costs', []):
        if c.get('name') == 'pts':
            return int(c.get('value', 0))
    return 0


def load_all_catalogues():
    """Load all JSON files into a dict by filename (without .json)."""
    cat_map = {}
    for f in os.listdir(SRC_DIR):
        if not f.endswith('.json') or f.startswith('Warhammer 40'):
            continue
        name = f.replace('.json', '')
        with open(os.path.join(SRC_DIR, f)) as fh:
            data = json.load(fh)
        cat_map[name] = data.get('catalogue', {})
    return cat_map


def get_library_units(cat, cat_map, visited=None):
    """Recursively get units from linked Library catalogues."""
    if visited is None:
        visited = set()
    
    units = []
    for link in cat.get('catalogueLinks', []):
        link_name = link.get('name', '')
        if link_name in visited or link_name not in cat_map:
            continue
        visited.add(link_name)
        
        # Only follow Library files, not other faction files
        if 'Library' not in link_name and 'Unaligned' not in link_name:
            continue
        
        lib_cat = cat_map[link_name]
        entries = lib_cat.get('sharedSelectionEntries', [])
        for e in entries:
            if e.get('type') in ('unit', 'model') and get_points(e) > 0:
                units.append(e)
        
        # Recurse into nested library links
        units.extend(get_library_units(lib_cat, cat_map, visited))
    
    return units


def convert_faction(fname, cat, cat_map, output_name=None):
    """Convert a single faction's JSON to Grimoire format."""
    faction_label = output_name or fname
    units = []
    
    # Get units from this catalogue
    entries = cat.get('sharedSelectionEntries', [])
    own_units = [e for e in entries if e.get('type') in ('unit', 'model') and get_points(e) > 0]
    
    # If no own units, try library links
    if not own_units:
        own_units = get_library_units(cat, cat_map)
    
    for entry in own_units:
        name = entry.get('name', '').strip()
        if not name:
            continue
        
        points = get_points(entry)
        if points == 0:
            continue
        
        models = extract_model_count(entry)
        categories = get_categories(entry)
        role = get_role(categories)
        
        # Find Unit profiles for stats
        profiles = find_unit_profiles(entry)
        stats = extract_stats(profiles[0]) if profiles else {}
        
        # Extract abilities
        abilities = extract_abilities(entry)
        
        # Determine hero status
        is_hero = role == 'HERO'
        
        # Check for character category
        all_cats = [cl.get('name', '') for cl in entry.get('categoryLinks', [])]
        if any('Character' in c for c in all_cats):
            is_hero = True
            role = 'HERO'
        
        # Check if can reinforce (most units can, except unique characters)
        can_reinforce = not is_hero and 'epic hero' not in ' '.join(categories).lower()
        
        unit = {
            'name': name,
            'faction': faction_label,
            'alliance': FACTION_ALLIANCE.get(faction_label, 'unaligned'),
            'points': points,
            'models': models,
            'move': stats.get('M', ''),
            'toughness': stats.get('T', ''),
            'save': stats.get('Sv', ''),
            'wounds': stats.get('W', ''),
            'leadership': stats.get('LD', ''),
            'objectiveControl': stats.get('OC', ''),
            'invulnerableSave': stats.get('InSv', ''),
            'role': role,
            'isHero': is_hero,
            'canReinforce': can_reinforce,
            'categories': categories,
            'abilities': abilities[:5],  # Top 5 abilities
            'system': '40k',
        }
        
        units.append(unit)
    
    return units


def convert_all():
    """Convert all 40K factions."""
    cat_map = load_all_catalogues()
    os.makedirs(OUT_DIR, exist_ok=True)
    
    total_units = 0
    faction_count = 0
    
    for fname in sorted(cat_map.keys()):
        if fname in SKIP_FACTIONS:
            continue
        
        # Skip SM supplements (merge into Space Marines later)
        if fname in SM_SUPPLEMENTS:
            continue
        
        output_name = RENAME_FACTIONS.get(fname, fname)
        cat = cat_map[fname]
        
        # Check if it's a library
        if cat.get('library', False):
            continue
        
        print(f'Converting: {fname}' + (f' (output: {output_name})' if fname != output_name else ''))
        units = convert_faction(fname, cat, cat_map, output_name=output_name)
        
        # Merge SM supplements into Space Marines
        if output_name == 'Space Marines':
            for supp in SM_SUPPLEMENTS:
                if supp in cat_map:
                    supp_name = RENAME_FACTIONS.get(supp, supp)
                    supp_units = convert_faction(supp, cat_map[supp], cat_map, output_name='Space Marines')
                    for u in supp_units:
                        if u['name'] not in [x['name'] for x in units]:
                            units.append(u)
                            print(f'  + {u["name"]} (from {supp_name})')
        
        if not units:
            print(f'  WARNING: No units found for {fname}')
            continue
        
        # Write units JSON
        out_file = os.path.join(OUT_DIR, f'{output_name}.json')
        with open(out_file, 'w') as f:
            json.dump(units, f, indent=2, ensure_ascii=False)
        
        total_units += len(units)
        faction_count += 1
        print(f'  {len(units)} units -> {out_file}')
    
    print(f'\nDone: {total_units} units across {faction_count} factions.')


if __name__ == '__main__':
    convert_all()
