import { describe, expect, it } from 'vitest';
import { ScriptedStream, type VirtualClock } from './scripted-stream.js';

/** A clock that never waits but records every duration it was asked for. */
function recordingClock(): VirtualClock & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    now: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('ScriptedStream', () => {
  it('replays in atMs order regardless of list order', () => {
    const clock = recordingClock();
    const s = new ScriptedStream({
      frames: [
        { atMs: 30, data: 'c' },
        { atMs: 10, data: 'a' },
        { atMs: 20, data: 'b' },
      ],
      clock,
    });
    // Ordering must be a property of the data, not of how the fixture was
    // written, or a reordered fixture silently changes behaviour.
    return expect(collect(s)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('waits the gap between frames, and scales with speed', async () => {
    const clock = recordingClock();
    await collect(
      new ScriptedStream({
        frames: [
          { atMs: 0, data: 1 },
          { atMs: 100, data: 2 },
          { atMs: 250, data: 3 },
        ],
        clock,
      }),
    );
    expect(clock.waits).toEqual([0, 100, 150]);

    const fast = recordingClock();
    await collect(
      new ScriptedStream({
        frames: [
          { atMs: 0, data: 1 },
          { atMs: 100, data: 2 },
        ],
        speed: 2,
        clock: fast,
      }),
    );
    expect(fast.waits).toEqual([0, 50]);
  });

  it('filters to strictly newer seqs when resuming', async () => {
    const clock = recordingClock();
    const frames = [1, 2, 3, 4, 5].map((n) => ({ atMs: n * 10, seq: BigInt(n), data: n }));

    expect(await collect(new ScriptedStream({ frames, startingSeq: 3n, clock }))).toEqual([4, 5]);
    // Resuming at the last seq seen yields nothing rather than replaying it.
    expect(await collect(new ScriptedStream({ frames, startingSeq: 5n, clock }))).toEqual([]);
    expect(await collect(new ScriptedStream({ frames, startingSeq: 0n, clock }))).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('drops unsequenced frames when a resume point is given', async () => {
    const clock = recordingClock();
    const s = new ScriptedStream({
      frames: [
        { atMs: 0, data: 'no-seq' },
        { atMs: 10, seq: 9n, data: 'seq-9' },
      ],
      startingSeq: 1n,
      clock,
    });
    // A frame with no sequence cannot be placed relative to the resume point,
    // so replaying it would risk a duplicate the client cannot detect.
    expect(await collect(s)).toEqual(['seq-9']);
  });

  it('stops when the signal aborts', async () => {
    const ac = new AbortController();
    const clock: VirtualClock = {
      now: () => 0,
      sleep: async (_ms, signal) => {
        if (signal?.aborted) throw new Error('aborted');
      },
    };
    const s = new ScriptedStream({
      frames: [
        { atMs: 0, data: 1 },
        { atMs: 10, data: 2 },
      ],
      clock,
    });
    ac.abort();
    await expect(collect({ [Symbol.asyncIterator]: () => s.play(ac.signal) })).rejects.toThrow();
  });
});
