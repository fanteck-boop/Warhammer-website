// The only tools the chat proxy forwards to Groq. The browser sends tool NAMES; the
// server substitutes these canonical definitions, so a client cannot inject its own
// tool descriptions (a prompt-injection vector) or extra tools.
// Keep in sync with TOOLS in muster-chat.js (tests/chat-function.test.mjs checks this).
export const TOOL_SCHEMAS = {
  find_units: { type: 'function', function: {
    name: 'find_units',
    description: 'Search/rank units of the current game system by points, wounds or value. Use for "most expensive", "cheapest", "best value", "what can I add for N points", and comparing units across factions. Returns up to 10 compact rows.',
    parameters: { type: 'object', properties: {
      faction: { type: 'string', description: 'Faction name (partial ok). Omit to search the whole game.' },
      name_contains: { type: 'string', description: 'Part of a unit name.' },
      keyword: { type: 'string', description: 'Keyword/category such as HERO, MONSTER, INFANTRY, UNIQUE.' },
      hero_only: { type: 'boolean' },
      min_points: { type: 'number' }, max_points: { type: 'number' },
      sort_by: { type: 'string', enum: ['points', 'wounds', 'points_per_wound', 'name'] },
      order: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'integer', description: '1 to 10, default 5' }
    } } } },
  get_unit: { type: 'function', function: {
    name: 'get_unit',
    description: 'Get the full stat line of ONE unit by name (points, stats, weapons, keywords). Use for stats of a named unit not in the army, or to check a unit exists.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Unit name.' },
      faction: { type: 'string', description: 'Optional faction, to disambiguate.' }
    }, required: ['name'] } } },
  search_rules: { type: 'function', function: {
    name: 'search_rules',
    description: 'Search the official free core rules (40k Core Rules, AoS Core Rules, MESBG Quickstart rules) for passages about a rules question, e.g. cover, charging, battle-shock, objectives. Returns up to 4 short passages with source, section and page.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Short rules question or keywords, e.g. "charge after advance".' },
      game: { type: 'string', enum: ['aos', '40k', 'mesbg'], description: 'Game system. Omit to use the current one.' }
    }, required: ['query'] } } }
};

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS);
