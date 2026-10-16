/** Injectable time source; wall-clock reads must not come from process globals in pure modules. */
export interface Clock {
  now(): Date;
}
