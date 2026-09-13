// Bubble's property-name table, read from Bubble's own engine.
//
// Bubble stores element properties under two naming schemes at once. Some are short
// codes (`%3` text, `%ps` placeholder, `%bgc` bgcolor); the rest use their long name
// (`padding_left`, `font_weight`, `order`). Nothing about a name tells you which, and
// getting it wrong is silent: Bubble answers 200 and stores a key the app never reads.
//
// The mapping is not a thing to derive by correlation, and not a thing to vendor. It
// ships inside `run.js`, the engine every published Bubble page loads, as one flat
// object of `long_name:"code"` pairs. Reading it from the user's own app means the
// table always matches the Bubble version that app is running.
//
// The same bundle carries `make_element("<Type>", { … field_names: { … } })` for every
// element type, which is the schema of what properties a type even has.

export class CodeTableError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'CodeTableError';
    this.hint = hint;
  }
}

// Pairs that have been in the table across every Bubble build seen so far. Used to
// locate the object and then to sanity-check that what was found is really it.
const ANCHORS = {
  data_source: 'ds',
  element_id: 'ei',
  placeholder: 'ps',
  contents: 'ct',
  custom_id: 'ci',
  icon: '9i',
};

function enclosingObject(text, index) {
  let depth = 0;
  let start = index;
  for (; start >= 0; start--) {
    const ch = text[start];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (start < 0) return null;
  let end = start;
  depth = 0;
  for (; end < text.length; end++) {
    const ch = text[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return end < text.length ? text.slice(start, end + 1) : null;
}

/**
 * Extract the long-name -> short-code table from run.js.
 *
 * Parsed with a regex rather than eval: the source is a JS object literal with
 * unquoted keys, the values are plain short strings, and running untrusted code
 * fetched over the network to read a lookup table would be indefensible.
 */
export function extractCodeTable(runJs) {
  if (typeof runJs !== 'string' || runJs.length < 1000) {
    throw new CodeTableError('run.js was empty or far too small to be the engine bundle');
  }

  let body = null;
  for (const [name, code] of Object.entries(ANCHORS)) {
    const at = runJs.indexOf(`${name}:"${code}"`);
    if (at < 0) continue;
    const candidate = enclosingObject(runJs, at);
    if (!candidate || candidate.length > 200_000) continue;
    body = candidate;
    break;
  }
  if (!body) {
    throw new CodeTableError('could not locate the property-code table in run.js', {
      hint:
        'Bubble may have changed how the engine is bundled. Report the app id and the ' +
        'run.js URL; the anchors in codes.mjs will need updating.',
    });
  }

  const table = {};
  for (const m of body.matchAll(/(?:^|[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([A-Za-z0-9_]{1,6})"/g)) {
    table[m[1]] = m[2];
  }

  const found = Object.entries(ANCHORS).filter(([n, c]) => table[n] === c).length;
  if (found < 3 || Object.keys(table).length < 40) {
    throw new CodeTableError(
      `the object found in run.js does not look like the code table ` +
        `(${Object.keys(table).length} entries, ${found}/${Object.keys(ANCHORS).length} anchors matched)`,
    );
  }
  return table;
}

/**
 * The storage key for a property on this Bubble version.
 * Short-coded properties become `%<code>`; everything else keeps its long name.
 */
export function storageKey(table, longName) {
  const code = table[longName];
  return code ? `%${code}` : longName;
}

/** Reverse lookup: what long name does a stored key correspond to? */
export function longName(table, key) {
  if (!key.startsWith('%')) return key;
  const code = key.slice(1);
  for (const [name, c] of Object.entries(table)) if (c === code) return name;
  return null;
}

/**
 * Per-element-type property schemas, from `make_element("<Type>", { … })`.
 * Tells you which properties a type accepts — a Video takes `video_source` and
 * `video_id`, never a bare URL — and their editor defaults.
 */
export function extractElementSchemas(runJs) {
  const schemas = {};
  for (const m of runJs.matchAll(/make_element\("([A-Za-z]+)"\s*,\s*\{/g)) {
    const type = m[1];
    const from = m.index;
    const fieldsAt = runJs.indexOf('field_names:', from);
    if (fieldsAt < 0 || fieldsAt - from > 6000) {
      schemas[type] = { fields: [], note: 'no field_names block nearby' };
      continue;
    }
    const open = runJs.indexOf('{', fieldsAt);
    let depth = 0;
    let end = open;
    for (; end < runJs.length; end++) {
      const ch = runJs[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const block = runJs.slice(open, end + 1);
    const fields = [];
    // top-level keys of field_names, i.e. the property names for this element type
    let d = 0;
    let token = '';
    for (let i = 1; i < block.length; i++) {
      const ch = block[i];
      if (ch === '{') d++;
      else if (ch === '}') d--;
      else if (d === 0 && ch === ':') {
        const name = token.trim().replace(/^[,{\s]+/, '');
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fields.push(name);
        token = '';
      } else if (d === 0 && ch === ',') token = '';
      else if (d === 0) token += ch;
    }
    schemas[type] = { fields: [...new Set(fields)] };
  }
  return schemas;
}

/**
 * Every built-in element type this Bubble build offers, with the named style each one
 * gets by default. Attaching that style is what lets a created element inherit the
 * app's real design tokens instead of invented colours and sizes.
 *
 * This is app settings, not engine code: it lives in the page's `dynamic.js`, never in
 * `run.js` (which only mentions the string in a getter) and not in the export.
 */
export function defaultStyles({ exportDoc, dynamicJs } = {}) {
  const fromExport = exportDoc?.settings?.default_styles;
  if (fromExport && Object.keys(fromExport).length) return fromExport;
  if (!dynamicJs) return {};
  const needle = '"default_styles":';
  const at = dynamicJs.indexOf(needle);
  if (at < 0) return {};
  const block = enclosingObject(dynamicJs, at + needle.length);
  if (!block) return {};
  const out = {};
  for (const m of block.matchAll(/"([A-Za-z]+)"\s*:\s*"([A-Za-z0-9_]+)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * A complete, app-specific vocabulary: the code table, the per-type schemas, and the
 * style registry. Everything a safe write needs to know about *this* Bubble version.
 */
export function buildVocabulary({ runJs, dynamicJs, exportDoc }) {
  const table = extractCodeTable(runJs);
  return {
    table,
    schemas: extractElementSchemas(runJs),
    defaultStyles: defaultStyles({ exportDoc, dynamicJs }),
    codedCount: Object.keys(table).length,
    key: (name) => storageKey(table, name),
  };
}
