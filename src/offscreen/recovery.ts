/**
 * GPU "device lost" recovery window tracker (PLAN §14.3).
 *
 * Allows up to `maxRecoveries` (default 3) within `windowMs` (default 10 minutes).
 * After the limit is exceeded, recovery stops and the caller can fall back or halt inference.
 */
export class RecoveryTracker {
  private readonly maxRecoveries: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRecoveries = 3, windowMs = 10 * 60 * 1000) {
    this.maxRecoveries = maxRecoveries;
    this.windowMs = windowMs;
  }

  /**
   * Records a recovery attempt at `now` and returns true if allowed, or false if
   * the retry limit within the rolling window has been exceeded.
   */
  tryRecord(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    if (this.timestamps.length >= this.maxRecoveries) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  count(now = Date.now()): number {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    return this.timestamps.length;
  }

  reset(): void {
    this.timestamps = [];
  }
}

