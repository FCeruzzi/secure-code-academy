// I binding del Worker, visibili da `env` di cloudflare:test.
declare namespace Cloudflare {
  interface Env extends Omit<import("../src/env").Env, never> {
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
  }
}
