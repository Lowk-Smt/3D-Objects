export interface TimingEntry {
  name: string;
  dur: number;
  desc?: string;
}

export interface HeaderCarrier {
  headers: Headers;
}

/**
 * Server-Timing header generator (RFC 7230 / W3C Server-Timing).
 * Collects execution timings for auth, DB, storage, and processing,
 * and formats them for the `Server-Timing` HTTP response header.
 */
export class ServerTiming {
  private entries: TimingEntry[] = [];

  time<T>(name: string, fn: () => T, desc?: string): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const dur = Math.round((performance.now() - start) * 100) / 100;
      this.entries.push({ name, dur, desc });
    }
  }

  async timeAsync<T>(name: string, fn: () => Promise<T>, desc?: string): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const dur = Math.round((performance.now() - start) * 100) / 100;
      this.entries.push({ name, dur, desc });
    }
  }

  record(name: string, durMs: number, desc?: string): void {
    const dur = Math.round(durMs * 100) / 100;
    this.entries.push({ name, dur, desc });
  }

  headerValue(): string {
    return this.entries
      .map((e) => {
        let s = `${e.name};dur=${e.dur}`;
        if (e.desc) s += `;desc="${e.desc.replace(/"/g, "'")}"`;
        return s;
      })
      .join(", ");
  }

  apply<T extends HeaderCarrier>(res: T): T {
    const val = this.headerValue();
    if (val) {
      res.headers.set("Server-Timing", val);
    }
    return res;
  }
}
