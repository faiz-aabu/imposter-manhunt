interface RateLimitBucket {
  timestamps: number[];
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  consume(
    key: string,
    maximumAttempts: number,
    windowMs: number,
    now = Date.now(),
  ): boolean {
    const cutoff = now - windowMs;
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter(
      (timestamp) => timestamp > cutoff,
    );

    if (bucket.timestamps.length >= maximumAttempts) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);

    if (this.buckets.size > 5_000) {
      this.removeExpiredBuckets(cutoff);
    }

    return true;
  }

  private removeExpiredBuckets(cutoff: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.timestamps.every((timestamp) => timestamp <= cutoff)) {
        this.buckets.delete(key);
      }
    }
  }
}
