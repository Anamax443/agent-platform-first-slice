// Injectable clock (VERIFICATION-CONTRACT §8.1). Platform logic never calls Date.now() directly.

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** ClockFixture: deterministic time for deadline, expiry and rotation tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(isoStart: string) {
    this.t = Date.parse(isoStart);
  }
  now(): Date {
    return new Date(this.t);
  }
  set(isoTime: string): void {
    this.t = Date.parse(isoTime);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const iso = (d: Date): string => d.toISOString();
export const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
