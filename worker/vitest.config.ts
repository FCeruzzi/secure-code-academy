import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SITE_ORIGIN: "https://example.github.io",
            ADMIN_USERNAMES: "alice,bruno,carla",
            // Poche iterazioni: nei test conta il comportamento, non il costo.
            PBKDF2_ITERATIONS: "1000",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // Sui runner di GitHub ogni richiesta al Worker simulato costa ~150 ms: i test che fanno
      // decine di iscrizioni o risposte di fila superano i 5 s predefiniti. Il comportamento lo
      // verificano le asserzioni, non il tempo.
      testTimeout: 30_000,
    },
  };
});
