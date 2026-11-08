// The composition watcher: the bot's automatic "these teams stopped being fair"
// rebalance, lifted out of bot.ts so it can be tested (bot.ts opens a socket and
// starts timers at import, so nothing can import it).
//
// The start-vote guard only helps while a vote runs; the mirror-image hole is a
// shuffle BEFORE the vote — a strong player leaves, a weaker one takes the slot,
// and the "balanced" 50/50 the lobby remembers is fiction by the time anyone
// calls !cv start. So the bot remembers the team-1 win chance it last REPORTED
// (any `.status` or a live `.balance` — the BASELINE) and, whenever the team
// composition changes, re-estimates the current win chance and decides whether to
// force a fresh arrangement.
//
// Two things make it act (`rebalanceVerdict`):
//
//   DEGRADED — |win−50| grew by more than `degradePp` since the baseline. This is
//   the "it got worse" rule the watcher was built for.
//
//   UNFAIR — |win−50| is over `absUnfairPp` right now, whatever the baseline says.
//   Needed because the baseline follows what the bot last REPORTED, and `.status`
//   reports the lobby as it is: on 2026-09-07, 18 of 28 `.status` runs baselined
//   the watcher on a lobby further than 10pp from even (13 of them further than
//   25pp — 2.7%, 94.9%, 97.9%). Once the baseline is 95% the degrade rule can
//   never fire again, and `.status` is auto-triggered by `!start` — so calling a
//   vote on a stacked lobby disarmed the watcher exactly when it mattered.
//
// Four gates stop it firing on its own tail (2026-09-07: 72 rebalances, one lobby
// taking 21 in three minutes):
//
//   FULL LOBBY ONLY. It acts at exactly `fullLobby` players. The win chance is an
//   OpenSkill predictWin over SUMMED ratings, so an 8v7 is a near-certain win on
//   team size alone — one player leaving a balanced 8v8 moved the estimate from
//   50.0% to 84.4%. Every join and leave in a filling lobby would read as a
//   catastrophic degrade. When someone leaves there is nothing to balance until
//   the lobby refills.
//
//   NOT DURING A GAME. Mid-match roster churn is noise and a forced arrangement
//   would fight the live game.
//
//   BLACKOUT. A live `!fb` takes 200-420ms to come back as CLIENTBATTLESTATUS, and
//   SPADS applies it in SEVERAL bursts; judging the lobby in that window measures a
//   half-applied arrangement (~100%) and starts a rival rebalance — on 2026-09-07
//   two conflicting `!fb`s went out 80ms apart and moved 16 players twice. So a
//   live force opens a blackout on the teams it asked for: nothing is judged until
//   the lobby REACHES them (`teamsLanded`) or `blackoutMs` passes. A composition
//   change during the blackout is queued and judged once, after it lifts.
//
//   RETRY COOLDOWN. If the blackout expires and the teams never landed, the force
//   did not take — for a reason we cannot see (host flood control, a player
//   switching straight back, an autoBalance the tracked setting missed). The
//   baseline is corrected to what the lobby REALLY is (never the arrangement we
//   only asked for) and no further automatic force goes out for
//   `retryCooldownMs`, or the UNFAIR rule above would re-fire on every roster
//   event and storm all over again.
//
// The dead band — don't move anyone when the balanced arrangement is within a
// point of what the lobby already has — lives in bot.ts's `runBalance`, which is
// the only place that knows what the balancer would produce.

/** A lobby member the watcher reasons about: a non-spectator and their ally team. */
export interface WatchedPlayer {
  name: string;
  ally: number;
}

/** The arrangement a live `!fb` asked for: the two groups, by lowercased name. */
export interface WantedTeams {
  first: string[];
  second: string[];
}

/**
 * Has the lobby arrived at the arrangement a `!fb` asked for?
 *
 * Deliberately NOT an equality check on the whole composition. It asks only what
 * the force controls: that everyone still present from the first group shares one
 * ally, everyone still present from the second shares another, and the two differ.
 *
 * So it tolerates the two things that happen constantly and have nothing to do
 * with whether the force worked — someone joining or leaving while SPADS applies
 * it — and it does not care WHICH ally numbers the lobby uses (`!fb` maps its
 * groups onto team 1/2, but a lobby is free to number its allies otherwise).
 *
 * False while the force is still landing: `sendTeams` only sends when at least one
 * player has to change side, so at least one is on the wrong one when it opens.
 */
export function teamsLanded(want: WantedTeams, current: WatchedPlayer[]): boolean {
  const allyOf = new Map(current.map((p) => [p.name.toLowerCase(), p.ally]));
  const soleAlly = (names: string[]): number | null => {
    let found: number | null = null;
    for (const name of names) {
      const ally = allyOf.get(name);
      if (ally === undefined) continue; // left while the force was landing
      if (found === null) found = ally;
      else if (found !== ally) return null; // group still split across sides
    }
    return found;
  };
  const a = soleAlly(want.first);
  const b = soleAlly(want.second);
  // Nobody left from a group tells us nothing — treat it as "not landed" rather
  // than declaring success for an arrangement we can no longer see.
  if (a === null || b === null) return false;
  return a !== b;
}

/** Thresholds and timings; bot.ts passes its own constants. */
export interface CompWatcherConfig {
  /** Act only at exactly this many non-spectator players. */
  fullLobby: number;
  /** DEGRADED rule: |win−50| may grow by at most this many points. */
  degradePp: number;
  /** UNFAIR rule: act whenever |win−50| exceeds this, baseline or no baseline. */
  absUnfairPp: number;
  /** Trailing debounce so a burst of roster lines is judged once, when settled. */
  debounceMs: number;
  /** Hard cap on how long a live force silences the watcher. */
  blackoutMs: number;
  /** No automatic force for this long after one failed to land or was blocked. */
  retryCooldownMs: number;
}

/** Why the watcher should (not) act. `act` false means do nothing at all. */
export type Verdict =
  | { act: false }
  | { act: true; reason: "unfair" | "degraded"; describe: string };

/**
 * The whole act/don't-act decision as a pure function of the numbers, so the
 * thresholds can be tested without timers, sockets or a lobby.
 *
 * `baseline` is the team-1 win chance the bot last reported (null = never), `win`
 * the lobby's current one. Both are percentages.
 */
export function rebalanceVerdict(
  baseline: number | null,
  win: number,
  cfg: Pick<CompWatcherConfig, "degradePp" | "absUnfairPp">,
): Verdict {
  const off = Math.abs(win - 50);
  // UNFAIR first: it holds however the lobby got here, so it also covers the case
  // where a `.status` on a stacked lobby has made the baseline useless.
  if (off > cfg.absUnfairPp) {
    return {
      act: true,
      reason: "unfair",
      describe:
        `team 1 win chance ${win.toFixed(1)}% is ${off.toFixed(1)}pp off even ` +
        `(over ${cfg.absUnfairPp}pp)`,
    };
  }
  if (baseline === null) return { act: false };
  const degrade = off - Math.abs(baseline - 50);
  if (degrade <= cfg.degradePp) return { act: false };
  return {
    act: true,
    reason: "degraded",
    describe:
      `team comp changed: win chance ${baseline.toFixed(1)}% → ${win.toFixed(1)}% ` +
      `(degraded ${degrade.toFixed(1)}pp)`,
  };
}

/** Everything the watcher needs from the running bot. */
export interface CompWatcherHooks {
  /**
   * The joined lobby's composition as a comparable string (name:ally, sorted);
   * "" when not in a battle. Any join/leave/side-switch/spec-change alters it.
   */
  signature(): string;
  /** The joined lobby's non-spectator players; [] when not in a battle. */
  players(): WatchedPlayer[];
  /** Team-1 win chance (%) for those players; null unless it is a two-team lobby. */
  winChance(players: WatchedPlayer[]): Promise<number | null>;
  /** True while the battle's game is running. */
  gameInProgress(): boolean;
  /** null when the bot may force teams, else the reason it may not (logged). */
  forceBlocked(): string | null;
  /**
   * Force a balanced arrangement. `currentWin` is the lobby's own win chance —
   * the reference for `runBalance`'s dead band. Resolves once the `!fb` has gone
   * out (or been skipped); a live send calls `startBlackout` from inside.
   */
  rebalance(currentWin: number): Promise<void>;
  /**
   * The lobby has ARRIVED at the teams the last live force asked for. This is the
   * only moment the bot may speak about that arrangement as a fact — bot.ts holds
   * the matchup line back until it fires.
   */
  onTeamsLanded(): void;
  /** The blackout ran out with the lobby never reaching them: the force is lost. */
  onForceLost(): void;
  /** stdout status line. */
  status(msg: string): void;
  /** Report an unexpected error without poisoning the watcher. */
  onError(context: string, e: unknown): void;
}

/**
 * The watcher's state machine. One instance per bot process; `reset()` clears it
 * when the battle changes or the connection drops.
 */
export class CompositionWatcher {
  private readonly cfg: CompWatcherConfig;
  private readonly hooks: CompWatcherHooks;

  /** Team-1 win chance (%) last reported by `.status`/a live force; null = none. */
  private win: number | null = null;
  /** The composition last seen, so an unchanged line is ignored. */
  private lastSignature = "";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private blackout: { want: WantedTeams; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A composition change that arrived while busy, to judge once free. */
  private queued = false;
  /** True while a check is running (its lookup / balance awaits). */
  private running = false;
  /**
   * No automatic force — nor the log line explaining why — before this time.
   * Set when a force fails to land AND when one is blocked outright (a lobby
   * whose autoBalance stays on is blocked forever; without this, every roster
   * event at a full lobby would re-log the same refusal).
   */
  private holdOffUntil = 0;

  constructor(cfg: CompWatcherConfig, hooks: CompWatcherHooks) {
    this.cfg = cfg;
    this.hooks = hooks;
  }

  /** The team-1 win chance the watcher is judging against (null = unbaselined). */
  get baseline(): number | null {
    return this.win;
  }

  /**
   * Re-baseline. Every `.status` summary and every live force does this; a
   * whispered preview moves nobody, so it must not. null = unbaselined (nothing
   * to compare against until the next report).
   */
  setBaseline(win: number | null): void {
    this.win = win;
  }

  /**
   * A live `!fb` just went out: judge nothing until the lobby reaches `want` or
   * `blackoutMs` passes.
   */
  startBlackout(want: WantedTeams): void {
    if (this.blackout !== null) clearTimeout(this.blackout.timer);
    if (this.debounceTimer !== null) {
      // Whatever that debounce was about, the arrangement now in flight
      // supersedes it — it is re-judged after the blackout if it still matters.
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.queued = true;
    }
    this.blackout = {
      want,
      timer: setTimeout(() => this.blackoutExpired(), this.cfg.blackoutMs),
    };
  }

  /**
   * Lift the blackout without judging the force's outcome — for a rejection the
   * bot has already diagnosed (the host's "autoBalance is enabled" PM), where the
   * caller corrects the baseline itself and a retry cooldown would only duplicate
   * the block already in `forceBlocked()`.
   */
  endBlackout(): void {
    if (this.blackout === null) return;
    clearTimeout(this.blackout.timer);
    this.blackout = null;
    this.drainQueue();
  }

  /**
   * The host told us, in so many words, that our `!fb` was thrown away — no need
   * to wait `blackoutMs` for `blackoutExpired` to infer it. Same treatment,
   * minus the guesswork: drop the blackout, correct the baseline to what the
   * lobby REALLY is (the matchup already announced was for teams it never got),
   * and hold off automatic forces for the retry cooldown, since the block that
   * refused this one is still in place — unless `holdOff` says the caller has just
   * REMOVED that block (cleared SPADS's autoBlockBalance), where waiting 30s would
   * only delay the retry that is now going to work. For a refusal the caller can
   * latch into `forceBlocked()` instead — an indefinite one — use `endBlackout`,
   * where the cooldown would only duplicate the block.
   */
  forceRejected(reason: string, holdOff = true): void {
    if (this.blackout !== null) {
      clearTimeout(this.blackout.timer);
      this.blackout = null;
    }
    this.queued = false;
    if (holdOff) this.holdOffUntil = Date.now() + this.cfg.retryCooldownMs;
    this.hooks.status(
      `the host rejected our !fb (${reason}) — the teams did NOT change; re-reading the lobby` +
        (holdOff ? ` and pausing automatic balancing for ${this.cfg.retryCooldownMs / 1000}s` : ""),
    );
    void this.rebaselineOnReality();
  }

  /** Clear everything: a new battle, or a dropped connection. */
  reset(): void {
    this.win = null;
    this.lastSignature = "";
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.blackout !== null) clearTimeout(this.blackout.timer);
    this.blackout = null;
    this.queued = false;
    this.holdOffUntil = 0;
  }

  /** One line for `.info`. */
  describe(): string {
    const cooldown = Math.max(0, this.holdOffUntil - Date.now());
    return (
      `baseline=${this.win === null ? "none" : `${this.win.toFixed(1)}%`} ` +
      `blackout=${this.blackout === null ? "no" : "yes"} ` +
      `queued=${this.queued ? "yes" : "no"} running=${this.running ? "yes" : "no"} ` +
      `retryCooldown=${cooldown === 0 ? "no" : `${Math.ceil(cooldown / 1000)}s`}`
    );
  }

  /**
   * Called (behind the tracker queue) after every roster-relevant protocol line.
   * On a composition change: during a blackout, queue it — or lift the blackout
   * when the lobby has arrived at the teams the force asked for, which leaves
   * nothing to judge, the composition then BEING the balanced one. Otherwise
   * (re)start the debounce so only the settled composition is judged.
   */
  observe(): void {
    const sig = this.hooks.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    if (this.blackout !== null) {
      if (!teamsLanded(this.blackout.want, this.hooks.players())) {
        this.queued = true;
        return;
      }
      this.hooks.status("blackout: the lobby reached the forced teams — lifting");
      this.queued = false;
      clearTimeout(this.blackout.timer);
      this.blackout = null;
      this.hooks.onTeamsLanded();
      return;
    }
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.run();
    }, this.cfg.debounceMs);
  }

  /**
   * The blackout ran out with the lobby never reaching the forced teams, so the
   * force did NOT take. Correct the baseline to what the lobby really is — the
   * matchup already announced was for an arrangement it never got — and hold off
   * automatic forces for `retryCooldownMs`, or the UNFAIR rule would re-fire on
   * the next roster event and storm.
   */
  private blackoutExpired(): void {
    this.blackout = null;
    this.holdOffUntil = Date.now() + this.cfg.retryCooldownMs;
    this.hooks.status(
      `blackout: the lobby did not reach the forced teams in ${this.cfg.blackoutMs / 1000}s — ` +
        `the force did not take; re-reading the lobby and pausing automatic balancing for ` +
        `${this.cfg.retryCooldownMs / 1000}s`,
    );
    this.queued = false;
    this.hooks.onForceLost();
    void this.rebaselineOnReality();
  }

  /**
   * Replace the baseline with the lobby's ACTUAL win chance. Used when a force
   * failed to land: the bot must never keep judging against teams it only asked
   * for. Never rebalances — this runs inside the retry cooldown.
   */
  private async rebaselineOnReality(): Promise<void> {
    try {
      const players = this.hooks.players();
      const win = await this.hooks.winChance(players);
      if (win === null) return;
      this.win = win;
      this.hooks.status(`baseline corrected to the lobby's real win chance: ${win.toFixed(1)}%`);
    } catch (e) {
      this.hooks.onError("composition watcher failed to re-read the lobby", e);
    }
  }

  /** Judge the settled composition once the watcher is free; queue if it is not. */
  private drainQueue(): void {
    if (!this.queued) return;
    this.queued = false;
    this.hooks.status("blackout over — judging the composition change it deferred");
    void this.run();
  }

  /**
   * Single-flight. LOOPS rather than recursing: a change that lands mid-run still
   * needs judging, unless the run itself opened a blackout — which then owns the
   * queue (`endBlackout`/the expiry path drain it).
   */
  private async run(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      for (;;) {
        try {
          await this.judge();
        } catch (e) {
          this.hooks.onError("composition watcher failed", e);
        }
        if (!this.queued || this.blackout !== null) return;
        this.queued = false;
      }
    } finally {
      this.running = false;
    }
  }

  /** One pass: gates, then the verdict, then (maybe) the rebalance. */
  private async judge(): Promise<void> {
    // Never while the game is running: the lobby comp changing mid-match (players
    // leaving, specs shuffling) is noise, and a force would fight the live game.
    if (this.hooks.gameInProgress()) return;
    const players = this.hooks.players();
    // Only a FULL lobby: at any other count one side is short, which the win-chance
    // estimate reads as a landslide, and the empty slot is about to be filled.
    if (players.length !== this.cfg.fullLobby) return;
    const win = await this.hooks.winChance(players);
    if (win === null) return;
    const verdict = rebalanceVerdict(this.win, win, this.cfg);
    if (!verdict.act) return;
    if (Date.now() < this.holdOffUntil) {
      // A force just failed, or is blocked. The reason was logged when the hold
      // began; stay quiet and keep the baseline honest rather than repeating it.
      this.win = win;
      return;
    }
    this.hooks.status(`${verdict.describe} — rebalancing`);
    const blocked = this.hooks.forceBlocked();
    if (blocked !== null) {
      // Can't act. Re-baseline so a DEGRADED verdict stops repeating, and hold
      // off besides: an UNFAIR verdict is absolute, so re-baselining alone would
      // not stop it re-logging on every roster event in a lobby that is blocked
      // for good (autoBalance left on).
      this.hooks.status(`  not rebalancing (${blocked})`);
      this.win = win;
      this.holdOffUntil = Date.now() + this.cfg.retryCooldownMs;
      return;
    }
    await this.hooks.rebalance(win);
  }
}
