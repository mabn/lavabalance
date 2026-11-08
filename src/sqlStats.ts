// SQL cost accounting for the SQLite-backed Durable Objects (RatingsDO, LosDO):
// what each public method has cost in SQLite rows since its instance started,
// served by GET /api/sqlstats and shown on the admin-only /sql page. Ported
// from barreplay's ReplayIndex.
//
// Durable Object storage is billed by rows read / rows written, with daily
// allowances on the Workers Free plan (5M reads, 100k writes per account) — so
// what matters is which METHOD spends them, which is what this tallies.
//
// The tally is IN MEMORY only, on purpose: persisting a measurement of the
// write budget would spend the budget it measures. The window is the DO
// instance's lifetime (a deploy or an eviction resets it), so the report says
// when counting started.
//
// How attribution works: `SqlAccounting` wraps `sql.exec` on the DO's
// SqlStorage so every statement bills its rowsRead / rowsWritten to the method
// currently stamped in `op`; `trackSqlOnPrototype` wraps every method of the DO
// class ON THE PROTOTYPE so calling one stamps its name. Outermost wins: a
// helper a method calls bills its caller, the endpoint's-eye view. The stamp is
// held for the SYNCHRONOUS part of a call only (a plain try/finally), which is
// exact for these DOs' methods — their SQL runs before any await. Statements
// run after an await are billed to the innermost wrapped method executing them
// (e.g. RatingsDO's background scrape lands on `writeChanged`), or to
// "(outside any method)" when there is none. Under `wrangler dev` that line
// always shows a couple of rows: Miniflare's DO wrapper records the object's
// name in its own `__miniflare_do_name` table through the same exec handle
// right after construction. Local-dev only; production has no such line.

// SqlStorage / SqlStorageValue are the runtime's global types (worker-configuration.d.ts).

/** One method's running totals. */
export interface SqlOpStats {
  calls: number;
  rowsRead: number;
  rowsWritten: number;
}

/** The report one DO serves: per method (most expensive first) and in total,
 * with when the counting started and how long that is — the numbers mean
 * nothing without their window. */
export interface SqlStatsReport {
  since: number;
  elapsedSec: number;
  ops: ({ op: string } & SqlOpStats)[];
  totals: { rowsRead: number; rowsWritten: number };
}

/** A single call crossing either threshold logs itself: that is how a new
 * scan announces itself in the live logs without an event per request. A
 * month's LOS upload legitimately writes thousands of rows (17 game_players
 * rows per game), hence the generous write threshold. */
const SQL_WARN_ROWS_READ = 5000;
const SQL_WARN_ROWS_WRITTEN = 2000;

/** What the exec shim hands back in place of the runtime's cursor: the rows,
 * already consumed, plus the cost counters — which are only final once the
 * cursor IS consumed, hence the eager read. Every caller in the DOs iterates
 * the cursor (`[...]`, `for of`) or takes `toArray()`; `one()`/`raw()` are
 * provided for completeness. */
interface ConsumedCursor<T extends Record<string, SqlStorageValue>> {
  rowsRead: number;
  rowsWritten: number;
  columnNames: string[];
  toArray(): T[];
  one(): T;
  raw(): IterableIterator<SqlStorageValue[]>;
  [Symbol.iterator](): IterableIterator<T>;
}

export class SqlAccounting {
  private readonly stats = new Map<string, SqlOpStats>();
  private readonly since = Date.now();
  /** The method currently executing — what the exec shim attributes each
   * statement to. Outermost wins. */
  private op: string | null = null;

  /** Wraps `sql.exec` in place. Install before the DO runs any SQL (i.e. first
   * thing in the constructor) so the schema DDL appears in the tally too. The
   * wrapper lives on the sql OBJECT and callers look `exec` up per call, so a
   * DO that stored `ctx.storage.sql` in a field still goes through it. */
  constructor(sql: SqlStorage) {
    const real = sql.exec.bind(sql);
    const shim = <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: unknown[]
    ): ConsumedCursor<T> => {
      const cur = real<T>(query, ...bindings);
      const rows = cur.toArray();
      const t = this.tally(this.op ?? "(outside any method)");
      t.rowsRead += cur.rowsRead;
      t.rowsWritten += cur.rowsWritten;
      return {
        rowsRead: cur.rowsRead,
        rowsWritten: cur.rowsWritten,
        columnNames: cur.columnNames,
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
          return rows[0]!;
        },
        raw: () => rows.map((r) => Object.values(r))[Symbol.iterator](),
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    };
    (sql as unknown as { exec: unknown }).exec = shim;
  }

  /** Runs one method under its name for the exec shim to bill. */
  tracked(name: string, fn: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown {
    if (this.op !== null) return fn.apply(self, args);
    const t = this.tally(name);
    t.calls += 1;
    const read = t.rowsRead;
    const written = t.rowsWritten;
    this.op = name;
    try {
      return fn.apply(self, args);
    } finally {
      this.op = null;
      const dRead = t.rowsRead - read;
      const dWritten = t.rowsWritten - written;
      if (dRead > SQL_WARN_ROWS_READ || dWritten > SQL_WARN_ROWS_WRITTEN) {
        console.warn(`sql cost: ${name} read=${dRead} written=${dWritten} rows in one call`);
      }
    }
  }

  private tally(op: string): SqlOpStats {
    let t = this.stats.get(op);
    if (t === undefined) {
      t = { calls: 0, rowsRead: 0, rowsWritten: 0 };
      this.stats.set(op, t);
    }
    return t;
  }

  report(): SqlStatsReport {
    const ops = [...this.stats.entries()]
      .map(([op, t]) => ({ op, ...t }))
      .sort((a, b) => b.rowsRead + b.rowsWritten - (a.rowsRead + a.rowsWritten));
    const totals = { rowsRead: 0, rowsWritten: 0 };
    for (const o of ops) {
      totals.rowsRead += o.rowsRead;
      totals.rowsWritten += o.rowsWritten;
    }
    return {
      since: this.since,
      elapsedSec: Math.round((Date.now() - this.since) / 1000),
      ops,
      totals,
    };
  }
}

/** A DO whose methods trackSqlOnPrototype can stamp: it holds its accounting
 * in a field (null until the constructor creates it — the wrapper passes a
 * call straight through until then). */
interface SqlTrackedObject {
  readonly sqlStats: SqlAccounting | undefined;
}

/**
 * Wraps every method of `cls` so calling it stamps its name for the exec shim.
 * Call ONCE at module load, right after the class declaration.
 *
 * The wrappers must live on the PROTOTYPE: barreplay's first version shadowed
 * each method with an instance property and the deployed runtime REFUSED those
 * RPC calls ("The RPC receiver does not implement the method") while the local
 * dev runtime silently bypassed the shadow — neither tests nor dev caught it.
 * Wrapped here the methods stay ordinary class methods in RPC's eyes, and a
 * test that patches a prototype method replaces the wrapper slot and still
 * takes effect, because the original bodies reach their helpers through
 * `this`. `skip` names the methods that must stay unwrapped (the report
 * itself, and anything the accounting is not meant to see).
 */
export function trackSqlOnPrototype(cls: { prototype: object }, skip: string[] = []): void {
  const proto = cls.prototype as Record<string, unknown>;
  const skipped = new Set(["constructor", ...skip]);
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (skipped.has(name)) continue;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== "function") continue; // accessors stay as they are
    const fn = desc.value as (...a: unknown[]) => unknown;
    proto[name] = function (this: SqlTrackedObject, ...args: unknown[]) {
      const acct = this.sqlStats;
      return acct ? acct.tracked(name, fn, this, args) : fn.apply(this, args);
    };
  }
}
