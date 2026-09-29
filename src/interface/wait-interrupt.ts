/** Lets the open task add wait take the first SIGINT, so the command signal aborts only on the next one. */
export type WaitInterrupt = {
  /** Called by the SIGINT handler; `false` means the handler aborts the command signal. */
  take(): boolean;
  /**
   * Opens the wait; `onTaken` runs once, on the first `take()` while it is open.
   * `close` reports whether this wait took a SIGINT.
   */
  open(onTaken: () => void): { close(): boolean };
};

type WaitState = { kind: 'closed' } | { kind: 'open'; onTaken: () => void } | { kind: 'taken' };

/**
 * Creates the interrupt state of one command, starting closed.
 *
 * The wizard runs one wait at a time, so `open` while a wait is open or taken
 * is a defect and throws.
 */
export function createWaitInterrupt(): WaitInterrupt {
  let state: WaitState = { kind: 'closed' };
  return {
    take() {
      if (state.kind !== 'open') {
        return false;
      }
      const { onTaken } = state;
      state = { kind: 'taken' };
      onTaken();
      return true;
    },
    open(onTaken) {
      if (state.kind !== 'closed') {
        throw new Error('unreachable: a wait opens only while no other wait is open');
      }
      state = { kind: 'open', onTaken };
      return {
        close() {
          const wasTaken = state.kind === 'taken';
          state = { kind: 'closed' };
          return wasTaken;
        },
      };
    },
  };
}
