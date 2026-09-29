/** Small seeded PRNG (mulberry32) with the random.Random helpers the engine uses: random, gauss, shuffle, sample, choice.
 *  Deterministic given the seed — Monte Carlo runs and tests are reproducible. Not bit-compatible with CPython's MT, by design. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }
  random(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(mu: number, sigma: number): number {
    let u = 0, v = 0; while (u === 0) u = this.random(); while (v === 0) v = this.random();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  sample<T>(a: T[], k: number): T[] { return this.shuffle([...a]).slice(0, Math.max(0, Math.min(k, a.length))); }
  choice<T>(a: T[]): T { return a[Math.floor(this.random() * a.length)]; }
}
