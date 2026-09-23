import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '../shared/types'

const defaults: AppSettings = {
  language: 'ar',
  ollamaEnabled: false,
  ollamaModel: 'qwen2.5:7b',
  whisperBinaryPath: '',
  whisperModelPath: ''
}

function discoverWhisperSettings(): Pick<AppSettings, 'whisperBinaryPath' | 'whisperModelPath'> {
  const binaryPath = join(process.cwd(), 'tools', 'whisper', 'Release', 'whisper-cli.exe')
  const modelPath = join(process.cwd(), 'tools', 'whisper', 'ggml-base.bin')
  return existsSync(binaryPath) && existsSync(modelPath)
    ? { whisperBinaryPath: binaryPath, whisperModelPath: modelPath }
    : { whisperBinaryPath: '', whisperModelPath: '' }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  const path = settingsPath()
  const discovered = discoverWhisperSettings()
  if (!existsSync(path)) return { ...defaults, ...discovered }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AppSettings>
    return {
      language: parsed.language === 'en' || parsed.language === 'fr' ? parsed.language : 'ar',
      ollamaEnabled: Boolean(parsed.ollamaEnabled),
      ollamaModel: typeof parsed.ollamaModel === 'string' ? parsed.ollamaModel.slice(0, 120) : defaults.ollamaModel,
      whisperBinaryPath: typeof parsed.whisperBinaryPath === 'string' && parsed.whisperBinaryPath ? parsed.whisperBinaryPath : discovered.whisperBinaryPath,
      whisperModelPath: typeof parsed.whisperModelPath === 'string' && parsed.whisperModelPath ? parsed.whisperModelPath : discovered.whisperModelPath
    }
  } catch {
    return defaults
  }
}

export async function saveSettings(input: AppSettings): Promise<AppSettings> {
  const settings: AppSettings = {
    language: input.language === 'en' || input.language === 'fr' ? input.language : 'ar',
    ollamaEnabled: Boolean(input.ollamaEnabled),
    ollamaModel: /^[\w.:/-]{1,120}$/.test(input.ollamaModel) ? input.ollamaModel : defaults.ollamaModel,
    whisperBinaryPath: String(input.whisperBinaryPath ?? '').slice(0, 1000),
    whisperModelPath: String(input.whisperModelPath ?? '').slice(0, 1000)
  }
  const path = settingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(settings, null, 2), 'utf8')
  return settings
}
