export class Semaphore {
  private queue: Array<(release: () => void) => void> = [];
  private current = 0;

  constructor(private capacity: number) {
    if (capacity < 1) {
      throw new Error("Semaphore capacity must be >= 1");
    }
  }

  async acquire(): Promise<() => void> {
    if (this.current < this.capacity) {
      this.current += 1;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push((release) => resolve(release));
    });
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release() {
    this.current -= 1;
    const next = this.queue.shift();
    if (next) {
      this.current += 1;
      next(() => this.release());
    }
  }
}
