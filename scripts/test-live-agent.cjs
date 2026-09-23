const { spawnSync } = require('node:child_process')
const { dirname, resolve } = require('node:path')

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error('Live Gemini integration was not started. Set GEMINI_API_KEY in your local environment, then run npm run test:live-agent. The key is not written by this script.')
  process.exit(2)
}

const vitestCli = resolve(dirname(require.resolve('vitest')), 'vitest.mjs')
const result = spawnSync(process.execPath, [vitestCli, 'run', 'src/main/liveGemini.integration.test.ts'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, RUN_LIVE_GEMINI: '1' }
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
