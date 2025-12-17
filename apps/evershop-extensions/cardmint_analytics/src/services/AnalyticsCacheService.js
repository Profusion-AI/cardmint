class AnalyticsCacheService {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value) {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear() {
    this.cache.clear();
  }
}

export const analyticsCache = new AnalyticsCacheService();
