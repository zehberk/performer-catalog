import { SessionFileAccessService } from './session-file-access.service';

describe('SessionFileAccessService', () => {
  it('queues a follow-up snapshot when another save is requested during an active write', async () => {
    const service = new SessionFileAccessService();
    service.supported.set(true);
    service.accessState.set('granted');

    let writeCount = 0;
    let releaseFirstWrite: (() => void) | undefined;

    (
      service as unknown as {
        writeSnapshot: () => Promise<void>;
      }
    ).writeSnapshot = () => {
      writeCount += 1;

      if (writeCount === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }

      return Promise.resolve();
    };

    service.syncSessionToDisk();
    await flushMicrotasks();
    expect(writeCount).toBe(1);

    service.syncSessionToDisk();
    await flushMicrotasks();
    expect(writeCount).toBe(1);

    releaseFirstWrite?.();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(writeCount).toBe(2);
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}
