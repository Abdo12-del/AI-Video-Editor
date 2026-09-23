import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

let logPath: string | null = null

export function getLogPath(): string {
  return logPath ?? join(app.getPath('userData'), 'logs', 'app.log')
}

export async function initializeLogger(): Promise<void> {
  logPath = join(app.getPath('userData'), 'logs', 'app.log')
  await mkdir(dirname(logPath), { recursive: true })
  await writeLog('info', 'application_started', { version: app.getVersion(), platform: process.platform })
}

export async function writeLog(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): Promise<void> {
  try {
    const target = getLogPath()
    await mkdir(dirname(target), { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...data })
    await appendFile(target, `${line}\n`, 'utf8')
  } catch (error) {
    console.error('Unable to write application log', error)
  }
}
