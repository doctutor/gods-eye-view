/**
 * A streaming reader of MySQL dump files, as Wikimedia publishes them
 * (`enwiki-latest-geo_tags.sql.gz`, `enwiki-latest-page.sql.gz`): the
 * `CREATE TABLE` statement gives the column order, and every `INSERT INTO
 * \`table\` VALUES (...),(...);` statement gives the rows. Text arrives in
 * chunks of any size; rows are handed out as soon as they are complete, and
 * nothing is kept but the unfinished tail. Values are NULL, numbers or
 * strings (with MySQL's backslash escapes undone); the dump is data, never
 * run.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const TUPLE = /\(((?:'(?:[^'\\]|\\[\s\S])*'|[^'()])*)\)/y;
const VALUE =
  /\s*(?:(NULL)|'((?:[^'\\]|\\[\s\S])*)'|(_binary\s*'(?:[^'\\]|\\[\s\S])*')|([^,]+))\s*(?:,|$)/y;
const ESCAPES = { n: '\n', r: '\r', t: '\t', 0: '\0', b: '\b', Z: '\x1a' };

/** A MySQL string literal's body, with its escapes undone. */
export function unescapeSql(body) {
  return body.replace(/\\([\s\S])/g, (_, c) => ESCAPES[c] ?? c);
}

/** One tuple's inner text as values: null, number or string. */
export function parseTupleValues(inner) {
  const values = [];
  VALUE.lastIndex = 0;
  while (VALUE.lastIndex < inner.length) {
    const at = VALUE.lastIndex;
    const match = VALUE.exec(inner);
    if (!match || match.index !== at)
      throw new Error(`Unreadable value at ${inner.slice(at, at + 40)}`);
    if (match[1] !== undefined) values.push(null);
    else if (match[2] !== undefined) values.push(unescapeSql(match[2]));
    else if (match[3] !== undefined)
      values.push(unescapeSql(match[3].replace(/^_binary\s*'|'$/g, '')));
    else {
      const raw = match[4].trim();
      if (/^0x[0-9a-f]+$/i.test(raw))
        values.push(Buffer.from(raw.slice(2), 'hex').toString('utf8'));
      else {
        const number = Number(raw);
        values.push(Number.isFinite(number) ? number : raw);
      }
    }
    if (VALUE.lastIndex === at) break;
  }
  return values;
}

/** The column names of a `CREATE TABLE` body, in order. */
export function parseColumns(body) {
  const columns = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*`([^`]+)`\s+\S/.exec(line);
    if (match) columns.push(match[1]);
  }
  return columns;
}

/**
 * A parser for one table of a dump.
 * @param {{table: string, onRow: (values: Array<null|number|string>, columns: string[]) => void,
 *   onColumns?: (columns: string[]) => void}} options
 * @returns {{write: (chunk: string) => void, end: () => {rows: number, inserts: number, columns: string[]}}}
 */
export function createDumpParser({ table, onRow, onColumns = () => {} }) {
  if (!/^\w+$/.test(table)) throw new Error('table must be a bare name');
  // The 2026 dumps put a newline after VALUES and one tuple per line;
  // older ones a space and the tuples on one line. Both are whitespace.
  const insertPrefix = `INSERT INTO \`${table}\` VALUES`;
  const createPrefix = `CREATE TABLE \`${table}\` (`;
  let tail = '';
  let columns = null;
  let inInsert = false;
  let rows = 0;
  let inserts = 0;

  function readCreate() {
    const start = tail.indexOf(createPrefix);
    if (start < 0) {
      // Keep enough of the tail that a prefix split across chunks is found.
      if (tail.length > 1 << 20) tail = tail.slice(-createPrefix.length);
      return false;
    }
    const end = tail.indexOf('\n)', start);
    if (end < 0) return false;
    columns = parseColumns(tail.slice(start + createPrefix.length, end));
    onColumns(columns);
    tail = tail.slice(end + 2);
    return true;
  }

  /**
   * Read whole tuples from the tail; stop at an incomplete tuple. A cursor
   * walks the tail and it is cut once at the end, so a long INSERT line is
   * never copied per row.
   */
  function readTuples() {
    let at = 0;
    try {
      for (;;) {
        if (!inInsert) {
          const start = tail.indexOf(insertPrefix, at);
          if (start < 0) {
            // Keep a prefix that may be split across chunks.
            at = Math.max(at, tail.length - insertPrefix.length);
            return;
          }
          at = start + insertPrefix.length;
          inInsert = true;
          inserts += 1;
        }
        // The separator after the previous tuple, when it has arrived.
        while (
          at < tail.length &&
          (tail[at] === ' ' || tail[at] === '\n' || tail[at] === '\r')
        )
          at++;
        if (at >= tail.length) return;
        if (tail[at] === ',') {
          at++;
          continue;
        }
        if (tail[at] === ';') {
          at++;
          inInsert = false;
          continue;
        }
        TUPLE.lastIndex = at;
        const match = TUPLE.exec(tail);
        if (!match) {
          if (tail.length - at > 1 << 24)
            throw new Error('A tuple never closed');
          if (tail[at] !== '(')
            throw new Error(
              `Unexpected ${JSON.stringify(tail[at])} in an INSERT`,
            );
          return; // the tuple is split across chunks
        }
        onRow(parseTupleValues(match[1]), columns);
        rows += 1;
        at += match[0].length;
      }
    } finally {
      tail = at > 0 ? tail.slice(at) : tail;
    }
  }

  return {
    write(chunk) {
      tail += chunk;
      if (!columns && !readCreate()) {
        if (tail.includes(insertPrefix))
          throw new Error(`No CREATE TABLE \`${table}\` before its rows`);
        return;
      }
      readTuples();
    },
    end() {
      if (inInsert && tail.trim())
        throw new Error('The dump ended inside an INSERT statement');
      return { rows, inserts, columns: columns || [] };
    },
  };
}

/**
 * Feed an async iterable of text (or bytes) through a parser.
 * @param {AsyncIterable<string|Uint8Array>} chunks
 */
export async function parseDumpStream(chunks, options) {
  const parser = createDumpParser(options);
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of chunks) {
    parser.write(
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true }),
    );
  }
  const rest = decoder.decode();
  if (rest) parser.write(rest);
  return parser.end();
}
