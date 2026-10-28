/**
 * Budget accounting (harness2 `core/ledger.py`): one task-level step at budget k spends
 * exactly R = 4k rollouts (k base + 2k candidates + k finals) and P = 3k improvement
 * stages (k INV + k DOM + k compositions). Selection and reflection are outside the ledger.
 */

export const expectedRollouts = (k: number): number => 4 * k
export const expectedSessions = (k: number): number => 3 * k

export class BudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetError'
  }
}

export interface LedgerEntry {
  kind: 'rollout' | 'session'
  label: string
  usd: number
  attempts: number
}

export class Ledger {
  readonly entries: LedgerEntry[] = []
  readonly mode: string
  readonly taskId: string
  readonly k: number

  constructor(mode: string, taskId: string, k: number) {
    this.mode = mode
    this.taskId = taskId
    this.k = k
  }

  rollout(label: string, usd = 0): void {
    this.entries.push({ kind: 'rollout', label, usd, attempts: 1 })
  }

  session(label: string, usd = 0, attempts = 1): void {
    this.entries.push({ kind: 'session', label, usd, attempts })
  }

  labels(kind: LedgerEntry['kind']): string[] {
    return this.entries.filter(e => e.kind === kind).map(e => e.label)
  }

  get R(): number {
    return this.labels('rollout').length
  }

  get P(): number {
    return this.labels('session').length
  }

  get usd(): number {
    return Math.round(this.entries.reduce((s, e) => s + e.usd, 0) * 1e6) / 1e6
  }

  /** Raise unless the ledger shows exactly R=4k and P=3k with no duplicate label. */
  assertIdentity(): void {
    for (const kind of ['rollout', 'session'] as const) {
      const ls = this.labels(kind)
      const dup = ls.filter((l, i) => ls.indexOf(l) !== i)
      if (dup.length) throw new BudgetError(`duplicate ${kind} label(s): ${[...new Set(dup)].join(', ')}`)
    }
    if (this.R !== expectedRollouts(this.k) || this.P !== expectedSessions(this.k)) {
      throw new BudgetError(
        `[${this.mode} ${this.taskId} k=${this.k}] expected R=${expectedRollouts(this.k)} P=${expectedSessions(this.k)}, got R=${this.R} P=${this.P}`,
      )
    }
  }

  toJSON(): object {
    return { mode: this.mode, taskId: this.taskId, k: this.k, R: this.R, P: this.P, usd: this.usd, entries: this.entries }
  }
}
