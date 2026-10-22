/**
 * Compact storage for the Wikipedia points build (points.mjs): columns of
 * typed arrays instead of one object a coordinate, and the titles in one
 * UTF-8 buffer, so eleven wikis' articles fit Node's default heap.
 *
 * Two traps this avoids. A value the dump parser hands out is a slice of
 * the text it was reading, and V8 keeps the whole of that text alive while
 * any slice of it is kept: a title held as a string held a stretch of the
 * page table with it, and the build's heap grew with every row read, not
 * every article kept. Here titles are copied into the pool as bytes and
 * types are interned as fresh strings, so nothing read is retained. And a
 * coordinate as an object (with its Map entry and its list) cost hundreds
 * of bytes; as columns it costs about fifty.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** A growable typed array: push, read and write by index, a view of what is used. */
export class Column {
  constructor(Type, capacity = 1024) {
    this.Type = Type;
    this.array = new Type(Math.max(16, capacity));
    this.length = 0;
  }

  push(value) {
    if (this.length === this.array.length) this.grow(this.length * 2);
    this.array[this.length] = value;
    return this.length++;
  }

  grow(capacity) {
    const next = new this.Type(capacity);
    next.set(this.array.subarray(0, this.length));
    this.array = next;
  }

  /** The used part (a view, valid until the next push). */
  view() {
    return this.array.subarray(0, this.length);
  }
}

/**
 * Strings as UTF-8 bytes in one growing buffer: add(text) → id, get(id) →
 * a fresh string. Nothing the caller passed in is kept.
 */
export class TextPool {
  constructor(capacity = 1 << 16) {
    this.bytes = Buffer.allocUnsafe(capacity);
    this.used = 0;
    this.starts = new Column(Uint32Array);
  }

  add(text) {
    const value = String(text);
    // UTF-8 is at most three bytes a UTF-16 unit.
    const most = value.length * 3;
    if (this.used + most > this.bytes.length) {
      const next = Buffer.allocUnsafe(
        Math.max(this.bytes.length * 2, this.used + most),
      );
      this.bytes.copy(next, 0, 0, this.used);
      this.bytes = next;
    }
    const id = this.starts.push(this.used);
    this.used += this.bytes.write(value, this.used, 'utf8');
    return id;
  }

  get(id) {
    const start = this.starts.array[id];
    const end =
      id + 1 < this.starts.length ? this.starts.array[id + 1] : this.used;
    return this.bytes.toString('utf8', start, end);
  }

  get size() {
    return this.starts.length;
  }
}

/**
 * Few distinct strings (GeoData's types) as small ids: the first of each
 * is kept as a fresh copy (never the parser's slice), get(id) is it.
 */
export class Interned {
  constructor() {
    this.ids = new Map();
    this.list = [];
  }

  id(text) {
    const value = String(text ?? '');
    let id = this.ids.get(value);
    if (id === undefined) {
      const fresh = Buffer.from(value, 'utf8').toString('utf8');
      id = this.list.length;
      this.list.push(fresh);
      this.ids.set(fresh, id);
    }
    return id;
  }

  get(id) {
    return this.list[id];
  }
}

/**
 * One wiki's geotagged coordinates and, once the page and page_props
 * tables are read, their articles: a coordinate a row of the columns,
 * chained per page (`next`, -1 at the end) with the primary first; `heads`
 * maps a page id to its first coordinate, in the order geo_tags first named
 * the page. The article's title (a pool id, -1 when the page is not an
 * article), size and Wikidata item are kept on the page's first row.
 */
export class WikiCoordinates {
  constructor() {
    this.heads = new Map();
    this.page = new Column(Uint32Array);
    this.x = new Column(Uint32Array);
    this.y = new Column(Uint32Array);
    this.dim = new Column(Float64Array);
    this.type = new Column(Uint16Array);
    this.flags = new Column(Uint8Array);
    this.next = new Column(Int32Array);
    this.tail = new Column(Int32Array);
    this.title = new Column(Int32Array);
    this.bytes = new Column(Float64Array);
    this.qid = new Column(Float64Array);
    this.types = new Interned();
    this.titles = new TextPool();
  }

  get count() {
    return this.page.length;
  }

  /** Add a coordinate; a primary one becomes the page's first. */
  add(page, { x, y, dim, type, flags, primary }) {
    const at = this.page.push(page);
    this.x.push(x);
    this.y.push(y);
    this.dim.push(dim);
    this.type.push(this.types.id(type));
    this.flags.push(flags);
    this.next.push(-1);
    this.tail.push(at);
    this.title.push(-1);
    this.bytes.push(0);
    this.qid.push(0);
    const head = this.heads.get(page);
    if (head === undefined) {
      this.heads.set(page, at);
      return;
    }
    if (primary) {
      // Ahead of the page's secondary coordinates.
      this.next.array[at] = head;
      this.tail.array[at] = this.tail.array[head];
      this.heads.set(page, at);
    } else {
      const last = this.tail.array[head];
      this.next.array[last] = at;
      this.tail.array[head] = at;
    }
  }

  /** Whether the page's coordinates already hold a primary one (always first). */
  hasPrimary(page) {
    const head = this.heads.get(page);
    return head !== undefined && !(this.flags.array[head] & 1);
  }

  /** Record the article (namespace 0, not a redirect) a page is. */
  setArticle(page, title, bytes) {
    const head = this.heads.get(page);
    if (head === undefined) return;
    this.title.array[head] = this.titles.add(title);
    this.bytes.array[head] = bytes;
  }

  setItem(page, qid) {
    const head = this.heads.get(page);
    if (head !== undefined) this.qid.array[head] = qid;
  }
}

/** A sort of `order` (a Uint32Array of record indexes) by `keyOf(index)` (0 to `range` − 1), stable. */
export function stableSortByKey(order, keyOf, range) {
  const counts = new Uint32Array(range + 1);
  const keys = new Uint32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const key = keyOf(order[i]);
    keys[i] = key;
    counts[key + 1] += 1;
  }
  for (let k = 0; k < range; k++) counts[k + 1] += counts[k];
  const out = new Uint32Array(order.length);
  for (let i = 0; i < order.length; i++) out[counts[keys[i]]++] = order[i];
  return out;
}

/**
 * One wiki's articles once its three dumps are joined: what the union
 * folds in, and what a checkpoint keeps (checkpoints.mjs). Articles only
 * (namespace 0, not redirects), in the order geo_tags first named them;
 * article i's title is pool id i, its coordinates the rows `first` to
 * `first + count − 1`, the primary first. No Map, no chains: columns a
 * checkpoint writes and reads as they are.
 */
export class WikiArticles {
  constructor() {
    this.page = new Column(Uint32Array);
    this.bytes = new Column(Float64Array);
    this.qid = new Column(Float64Array);
    this.first = new Column(Uint32Array);
    this.count = new Column(Uint32Array);
    this.titles = new TextPool();
    this.x = new Column(Uint32Array);
    this.y = new Column(Uint32Array);
    this.dim = new Column(Float64Array);
    this.type = new Column(Uint16Array);
    this.flags = new Column(Uint8Array);
    this.types = [];
  }

  get articles() {
    return this.page.length;
  }

  get coordinates() {
    return this.x.length;
  }

  /** The articles of a wiki's coordinates (WikiCoordinates, read through its three dumps). */
  static fromCoordinates(c) {
    const out = new WikiArticles();
    // The coordinates' type ids carry over; the list is theirs.
    out.types = c.types.list.slice();
    for (const [page, head] of c.heads) {
      const titleId = c.title.array[head];
      if (titleId < 0) continue; // not an article
      out.page.push(page);
      out.bytes.push(c.bytes.array[head]);
      out.qid.push(c.qid.array[head]);
      out.first.push(out.x.length);
      out.titles.add(c.titles.get(titleId));
      let n = 0;
      for (let at = head; at >= 0; at = c.next.array[at]) {
        out.x.push(c.x.array[at]);
        out.y.push(c.y.array[at]);
        out.dim.push(c.dim.array[at]);
        out.type.push(c.type.array[at]);
        out.flags.push(c.flags.array[at]);
        n += 1;
      }
      out.count.push(n);
    }
    return out;
  }
}
