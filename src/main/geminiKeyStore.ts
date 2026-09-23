import { safeStorage, app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GeminiApiKeyStatus } from '../shared/types'

function keyFilePath(): string {
  return join(app.getPath('userData'), 'secrets', 'gemini-api-key.enc')
}

function isSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text' || backend === 'unknown') return false
  }
  return true
}

export async function getGeminiApiKeyStatus(): Promise<GeminiApiKeyStatus> {
  const path = keyFilePath()
  return {
    configured: existsSync(path),
    secureStorageAvailable: isSecureStorageAvailable()
  }
}

export async function getGeminiApiKey(): Promise<string | null> {
  const path = keyFilePath()
  if (!existsSync(path)) return null
  if (!isSecureStorageAvailable()) throw new Error('Secure local storage is unavailable. Configure Windows Data Protection or an operating-system keychain before saving a Gemini key.')
  try {
    const encrypted = await readFile(path)
    const key = safeStorage.decryptString(encrypted).trim()
    return key || null
  } catch {
    throw new Error('The saved Gemini API key could not be decrypted. Clear it and save the key again.')
  }
}

export async function saveGeminiApiKey(input: string): Promise<GeminiApiKeyStatus> {
  const key = String(input ?? '').trim()
  if (key.length < 20 || key.length > 512 || /[\r\n\0]/.test(key)) {
    throw new Error('Enter a valid Gemini API key (20–512 characters).')
  }
  if (!isSecureStorageAvailable()) {
    throw new Error('Secure local storage is unavailable. The API key was not saved.')
  }

  const target = keyFilePath()
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await mkdir(join(app.getPath('userData'), 'secrets'), { recursive: true })
    const encrypted = safeStorage.encryptString(key)
    await writeFile(temporary, encrypted, { mode: 0o600 })
    await rename(temporary, target)
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new Error('Could not securely save the Gemini API key. The key was not written to settings or logs.')
  }
  return getGeminiApiKeyStatus()
}

export async function clearGeminiApiKey(): Promise<GeminiApiKeyStatus> {
  await rm(keyFilePath(), { force: true }).catch(() => {
    throw new Error('Could not clear the saved Gemini API key.')
  })
  return getGeminiApiKeyStatus()
}
