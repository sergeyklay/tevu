// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createWaitInterrupt } from './wait-interrupt';

describe('createWaitInterrupt', () => {
  describe('when closed', () => {
    it('returns false from take', () => {
      const waitInterrupt = createWaitInterrupt();

      expect(waitInterrupt.take()).toBe(false);
    });

    it('opens a wait that has not taken a SIGINT', () => {
      const waitInterrupt = createWaitInterrupt();
      const onTaken = vi.fn();

      const held = waitInterrupt.open(onTaken);

      expect(onTaken).not.toHaveBeenCalled();
      expect(held.close()).toBe(false);
    });
  });

  describe('when open', () => {
    it('returns true from the first take and runs onTaken once', () => {
      const waitInterrupt = createWaitInterrupt();
      const onTaken = vi.fn();
      waitInterrupt.open(onTaken);

      const taken = waitInterrupt.take();

      expect(taken).toBe(true);
      expect(onTaken).toHaveBeenCalledOnce();
    });

    it('throws an unreachable defect on a second open', () => {
      const waitInterrupt = createWaitInterrupt();
      waitInterrupt.open(vi.fn());

      expect(() => waitInterrupt.open(vi.fn())).toThrow(/^unreachable:/);
    });

    it('returns to closed on close, so take returns false again', () => {
      const waitInterrupt = createWaitInterrupt();
      const onTaken = vi.fn();
      waitInterrupt.open(onTaken).close();

      const taken = waitInterrupt.take();

      expect(taken).toBe(false);
      expect(onTaken).not.toHaveBeenCalled();
    });
  });

  describe('when taken', () => {
    it('returns false from every later take and does not run onTaken again', () => {
      const waitInterrupt = createWaitInterrupt();
      const onTaken = vi.fn();
      waitInterrupt.open(onTaken);
      waitInterrupt.take();

      const later = [waitInterrupt.take(), waitInterrupt.take()];

      expect(later).toEqual([false, false]);
      expect(onTaken).toHaveBeenCalledOnce();
    });

    it('throws an unreachable defect on a second open', () => {
      const waitInterrupt = createWaitInterrupt();
      waitInterrupt.open(vi.fn());
      waitInterrupt.take();

      expect(() => waitInterrupt.open(vi.fn())).toThrow(/^unreachable:/);
    });

    it('returns true from close for the wait that took the SIGINT', () => {
      const waitInterrupt = createWaitInterrupt();
      const held = waitInterrupt.open(vi.fn());
      waitInterrupt.take();

      expect(held.close()).toBe(true);
    });
  });

  describe('across waits', () => {
    it('reports a SIGINT only to the wait that took it', () => {
      const waitInterrupt = createWaitInterrupt();
      const first = waitInterrupt.open(vi.fn());
      waitInterrupt.take();
      const firstTaken = first.close();

      const second = waitInterrupt.open(vi.fn());

      expect(firstTaken).toBe(true);
      expect(second.close()).toBe(false);
    });

    it('lets a later wait take its own first SIGINT', () => {
      const waitInterrupt = createWaitInterrupt();
      const first = waitInterrupt.open(vi.fn());
      waitInterrupt.take();
      first.close();
      const onTaken = vi.fn();
      waitInterrupt.open(onTaken);

      const taken = waitInterrupt.take();

      expect(taken).toBe(true);
      expect(onTaken).toHaveBeenCalledOnce();
    });
  });
});
