// Addressing.
//
// A Bubble path is the same dotted string the write endpoint takes:
//
//   %p3.<page>.%el.<element>.%p.<property>      an element property
//   %p3.<page>.%wf.<workflow>.actions.<n>       a workflow step
//   %p3.<page>.%el.<element>.%s.<n>             a conditional state
//
// Segments are OBJECT KEYS (an element's slot in its parent), not element ids. The two
// namespaces differ and confusing them is the most common way to address nothing at
// all. `_index.id_to_path` maps id -> path and is maintained by Bubble itself.

/** Short segment -> the long key the export renders it as. */
export const SEGMENTS = {
  '%p3': 'pages',
  '%el': 'elements',
  '%p': 'properties',
  '%wf': 'workflows',
  '%ed': 'element_definitions',
  '%s': 'states',
};

/**
 * Walk a dotted path through an export document.
 *
 * The write endpoint addresses properties by their storage key (`%3`), but the export
 * renders every coded property under its long name (`text`). Reading `…%p.%3` off an
 * export therefore finds nothing unless the segment is translated first. Pass the
 * vocabulary to get that translation — without it, a coded property looks absent, which
 * makes an update look like a create and a revert look like a deletion.
 */
export function readPath(doc, dotted, vocabulary = null) {
  const segs = String(dotted).split('.').filter(Boolean);
  let cur = doc;
  let inProperties = false;
  for (const seg of segs) {
    if (cur == null) return undefined;
    let key = SEGMENTS[seg] ?? seg;
    if (inProperties && seg.startsWith('%') && vocabulary) {
      const long = longNameFor(vocabulary, seg);
      if (long && cur[seg] === undefined) key = long;
    }
    cur = cur[key];
    inProperties = seg === '%p';
  }
  return cur;
}

function longNameFor(vocabulary, key) {
  const table = vocabulary?.table ?? vocabulary;
  if (!table) return null;
  const code = key.slice(1);
  for (const [name, c] of Object.entries(table)) if (c === code) return name;
  return null;
}

/** Does this path resolve to something? */
export function pathExists(doc, dotted) {
  return readPath(doc, dotted) !== undefined;
}

/** The parent path of a dotted path, or null at the root. */
export function parentPath(dotted) {
  const parts = String(dotted).split('.').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('.') : null;
}

/** Look up an element id in Bubble's own index. */
export function pathForId(doc, id) {
  return doc?._index?.id_to_path?.[id] ?? null;
}

/** Every page, as {key, id, name, elements, workflows}. */
export function listPages(doc) {
  return Object.entries(doc.pages ?? {}).map(([key, p]) => ({
    key,
    id: p.id,
    name: p.name,
    elements: Object.keys(p.elements ?? {}).length,
    workflows: Object.keys(p.workflows ?? {}).length,
  }));
}

/** Resolve a page by name, object key or element id. */
export function findPage(doc, needle) {
  const pages = Object.entries(doc.pages ?? {});
  for (const [key, p] of pages) if (key === needle || p.id === needle || p.name === needle) {
    return { key, path: `%p3.${key}`, ...p };
  }
  const lower = String(needle).toLowerCase();
  for (const [key, p] of pages) if (String(p.name).toLowerCase() === lower) {
    return { key, path: `%p3.${key}`, ...p };
  }
  return null;
}

/**
 * Walk every element under a page, yielding {key, path, id, name, type, depth}.
 * Placeholders without an id can still carry children, so the walk never prunes on a
 * missing id — doing so has silently dropped real elements before.
 */
export function walkElements(pageNode, basePath) {
  const out = [];
  const visit = (els, path, depth) => {
    for (const [key, el] of Object.entries(els ?? {})) {
      const p = `${path}.%el.${key}`;
      out.push({
        key,
        path: p,
        id: el?.id ?? null,
        name: el?.name ?? el?.default_name ?? null,
        type: el?.type ?? null,
        depth,
        children: Object.keys(el?.elements ?? {}).length,
      });
      if (el?.elements) visit(el.elements, p, depth + 1);
    }
  };
  visit(pageNode.elements, basePath, 0);
  return out;
}

/** Find elements on a page by name, id or key. Substring match on name as a fallback. */
export function findElements(doc, pageNeedle, elementNeedle) {
  const page = findPage(doc, pageNeedle);
  if (!page) return { page: null, matches: [] };
  const all = walkElements(page, page.path);
  if (!elementNeedle) return { page, matches: all };
  const exact = all.filter(
    (e) => e.key === elementNeedle || e.id === elementNeedle || e.name === elementNeedle,
  );
  if (exact.length) return { page, matches: exact };
  const lower = String(elementNeedle).toLowerCase();
  return { page, matches: all.filter((e) => String(e.name ?? '').toLowerCase().includes(lower)) };
}

/**
 * Mint an object key and element id that cannot collide with Bubble's own counter.
 *
 * Bubble allocates ids in ascending blocks (this account was in `bTL*` while `bTG*`
 * was long spent). Ids are minted client-side and only need to be unique, so a prefix
 * far ahead of the frontier stays clear of anything Bubble will issue.
 */
export function mintIds(doc, { prefix = 'bTZ', count = 1 } = {}) {
  const used = new Set(Object.keys(doc?._index?.id_to_path ?? {}));
  const collect = (els) => {
    for (const [key, el] of Object.entries(els ?? {})) {
      used.add(key);
      if (el?.id) used.add(el.id);
      if (el?.elements) collect(el.elements);
    }
  };
  for (const p of Object.values(doc?.pages ?? {})) collect(p.elements);

  const out = [];
  let n = 0;
  while (out.length < count) {
    n++;
    const suffix = n.toString(36).padStart(3, '0');
    const key = `${prefix}o${suffix}`;
    const id = `${prefix}i${suffix}`;
    if (used.has(key) || used.has(id)) continue;
    used.add(key);
    used.add(id);
    out.push({ key, id });
  }
  return out;
}
