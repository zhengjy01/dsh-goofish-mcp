/**
 * dsh-xianyu — standalone host-only build config.
 *
 * Bundles only the host (node) half into lib/index.js as ESM, keeping
 * @deepseek-ai/* peer providers external (resolved at runtime from the DSH
 * host). No client bundle: goofish login happens on the CLI (cookie file
 * ~/.goofish-cli/cookies.json), and configuration is driven by agent tools +
 * ~/.dsh/dsh-xianyu.json — so no web settings panel is required.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'lib',
  clean: true,
  target: 'node22',
  sourcemap: true,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-llm',
  ],
})
