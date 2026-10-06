/** Unbounded single-consumer queue bridging stream callbacks to an async iterable. */
export interface LineQueue {
  push(line: string): void;
  close(): void;
  readonly lines: AsyncIterable<string>;
}

/** Consumed lines are compacted away in batches, so a long run does not keep its whole history in memory. */
const COMPACT_AFTER = 1024;

export function createLineQueue(): LineQueue {
  let buffer: string[] = [];
  let head = 0;
  let closed = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    wake?.();
    wake = undefined;
  };

  const take = (): string | undefined => {
    const line = buffer[head];
    if (line === undefined) return undefined;
    head += 1;
    if (head >= COMPACT_AFTER) {
      buffer = buffer.slice(head);
      head = 0;
    }
    return line;
  };

  const nextPush = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
    });

  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      const line = take();
      if (line !== undefined) yield line;
      else if (closed) return;
      else await nextPush();
    }
  }

  return {
    push(line) {
      buffer.push(line);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    lines: { [Symbol.asyncIterator]: lines },
  };
}
