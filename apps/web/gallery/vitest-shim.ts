/** The two `vi` calls the test suite's fake server makes, for the gallery's browser: a plain function and a global. */
export const vi = {
  fn: <T>(f: T): T => f,
  stubGlobal(name: string, value: unknown) {
    (globalThis as Record<string, unknown>)[name] = value;
  },
};
