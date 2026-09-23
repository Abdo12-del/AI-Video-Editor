const { spawnSync } = require('node:child_process')
const { dirname, resolve } = require('node:path')

const vitestCli = resolve(dirname(require.resolve('vitest')), 'vitest.mjs')
const result = spawnSync(process.execPath, [
  vitestCli,
  'run',
  'src/main/mediaEngine.integration.test.ts',
  'src/main/editorJourney.integration.test.ts'
], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, RUN_MEDIA_INTEGRATION: '1', RUN_MEDIA_E2E: '1' }
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
