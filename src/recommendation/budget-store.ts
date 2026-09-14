import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecommendationError } from './types.js';

interface Counter {
  calls: number;
  tokens: number;
  costMicros: number;
}

interface BudgetState {
  schemaVersion: 1;
  date: string;
  global: Counter;
  subjects: Record<string, Counter>;
}

export interface BudgetReservation {
  subjectHash: string;
  tokens: number;
  costMicros: number;
  date: string;
}

export class RecommendationBudgetStore {
  private state: BudgetState | undefined;
  private unavailable = false;
  private operation = Promise.resolve();

  constructor(
    private readonly options: {
      stateFile: string;
      timezone: string;
      maxSubjects: number;
      subjectDailyCalls: number;
      subjectDailyTokens: number;
      globalDailyCalls: number;
      globalDailyTokens: number;
      globalDailyCostYuan: number;
      inputYuanPerMillionTokens: number;
      outputYuanPerMillionTokens: number;
      now?: () => Date;
    },
  ) {}

  async start(): Promise<void> {
    try {
      const raw = await readFile(this.options.stateFile, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      this.state = raw === undefined ? this.emptyState() : this.parse(raw);
      this.rollover();
      await this.save();
    } catch {
      this.unavailable = true;
    }
  }

  reserve(
    subjectHash: string,
    estimatedInputTokens: number,
    maxOutputTokens: number,
  ): Promise<BudgetReservation> {
    return this.exclusive(async () => {
      this.assertAvailable();
      this.rollover();
      const state = this.state!;
      const tokens = estimatedInputTokens + maxOutputTokens;
      const costMicros = Math.ceil(
        estimatedInputTokens * this.options.inputYuanPerMillionTokens +
          maxOutputTokens * this.options.outputYuanPerMillionTokens,
      );
      const subject = state.subjects[subjectHash];
      if (!subject && Object.keys(state.subjects).length >= this.options.maxSubjects) {
        throw new RecommendationError(
          503,
          'RECOMMENDATION_CAPACITY_EXCEEDED',
          '推荐预算主体容量已满',
          true,
          60,
        );
      }
      const nextSubject = add(subject ?? zero(), tokens, costMicros);
      if (
        nextSubject.calls > this.options.subjectDailyCalls ||
        nextSubject.tokens > this.options.subjectDailyTokens
      ) {
        throw new RecommendationError(
          429,
          'RECOMMENDATION_SUBJECT_BUDGET_EXHAUSTED',
          '今日推荐额度已用尽',
          false,
          this.secondsUntilNextDay(),
        );
      }
      const nextGlobal = add(state.global, tokens, costMicros);
      if (
        nextGlobal.calls > this.options.globalDailyCalls ||
        nextGlobal.tokens > this.options.globalDailyTokens ||
        nextGlobal.costMicros > this.options.globalDailyCostYuan * 1_000_000
      ) {
        throw new RecommendationError(
          503,
          'RECOMMENDATION_GLOBAL_BUDGET_EXHAUSTED',
          '今日推荐服务全局额度已用尽',
          false,
          this.secondsUntilNextDay(),
        );
      }
      state.subjects[subjectHash] = nextSubject;
      state.global = nextGlobal;
      await this.saveOrFailClosed();
      return { subjectHash, tokens, costMicros, date: state.date };
    });
  }

  settle(
    reservation: BudgetReservation,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    return this.exclusive(async () => {
      this.assertAvailable();
      this.rollover();
      const state = this.state!;
      if (reservation.date !== state.date) return;
      const actualTokens = Math.max(0, promptTokens) + Math.max(0, completionTokens);
      const actualCost = Math.ceil(
        Math.max(0, promptTokens) * this.options.inputYuanPerMillionTokens +
          Math.max(0, completionTokens) * this.options.outputYuanPerMillionTokens,
      );
      const subject = state.subjects[reservation.subjectHash];
      if (!subject) return;
      subject.tokens = Math.max(0, subject.tokens - reservation.tokens + actualTokens);
      subject.costMicros = Math.max(0, subject.costMicros - reservation.costMicros + actualCost);
      state.global.tokens = Math.max(0, state.global.tokens - reservation.tokens + actualTokens);
      state.global.costMicros = Math.max(
        0,
        state.global.costMicros - reservation.costMicros + actualCost,
      );
      await this.saveOrFailClosed();
    });
  }

  diagnostics(): object {
    return {
      available: !this.unavailable,
      date: this.state?.date,
      subjects: this.state ? Object.keys(this.state.subjects).length : 0,
      global: this.state?.global,
    };
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertAvailable(): void {
    if (this.unavailable || !this.state) {
      throw new RecommendationError(
        503,
        'RECOMMENDATION_BUDGET_STATE_UNAVAILABLE',
        '推荐预算状态不可用',
        true,
        60,
      );
    }
  }

  private parse(raw: string): BudgetState {
    const value = JSON.parse(raw) as Partial<BudgetState>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.date !== 'string' ||
      !validCounter(value.global) ||
      !value.subjects ||
      typeof value.subjects !== 'object' ||
      Object.values(value.subjects).some((counter) => !validCounter(counter))
    )
      throw new Error('invalid recommendation budget state');
    return value as BudgetState;
  }

  private rollover(): void {
    const date = this.dateKey();
    if (!this.state || this.state.date !== date) this.state = this.emptyState();
  }

  private emptyState(): BudgetState {
    return { schemaVersion: 1, date: this.dateKey(), global: zero(), subjects: {} };
  }

  private async saveOrFailClosed(): Promise<void> {
    try {
      await this.save();
    } catch {
      this.unavailable = true;
      throw new RecommendationError(
        503,
        'RECOMMENDATION_BUDGET_STATE_UNAVAILABLE',
        '推荐预算状态不可用',
        true,
        60,
      );
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    const temporary = `${this.options.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.options.stateFile);
  }

  private dateKey(): string {
    return this.dateKeyFor(this.options.now?.() ?? new Date());
  }

  private dateKeyFor(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.options.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private secondsUntilNextDay(): number {
    const now = this.options.now?.() ?? new Date();
    const today = this.dateKey();
    for (let seconds = 60; seconds <= 90_000; seconds += 60) {
      const candidate = new Date(now.getTime() + seconds * 1_000);
      const key = this.dateKeyFor(candidate);
      if (key !== today) return seconds;
    }
    return 86_400;
  }
}

function zero(): Counter {
  return { calls: 0, tokens: 0, costMicros: 0 };
}

function add(counter: Counter, tokens: number, costMicros: number): Counter {
  return {
    calls: counter.calls + 1,
    tokens: counter.tokens + tokens,
    costMicros: counter.costMicros + costMicros,
  };
}

function validCounter(value: unknown): value is Counter {
  if (!value || typeof value !== 'object') return false;
  const counter = value as Counter;
  return [counter.calls, counter.tokens, counter.costMicros].every(
    (item) => Number.isFinite(item) && item >= 0,
  );
}
