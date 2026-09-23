import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storageMock = vi.hoisted(() => ({
  userDataPath: '',
  encryptionAvailable: true,
  backend: 'gnome_libsecret',
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => Buffer.from(value.toString('utf8').replace(/^encrypted:/, ''), 'base64').toString('utf8'))
}))

vi.mock('electron', () => ({
  app: { getPath: () => storageMock.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => storageMock.encryptionAvailable,
    getSelectedStorageBackend: () => storageMock.backend,
    encryptString: (value: string) => storageMock.encryptString(value),
    decryptString: (value: Buffer) => storageMock.decryptString(value)
  }
}))

import { clearGeminiApiKey, getGeminiApiKey, getGeminiApiKeyStatus, saveGeminiApiKey } from './geminiKeyStore'

let testDirectory = ''

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'aivideo-gemini-key-'))
  storageMock.userDataPath = testDirectory
  storageMock.encryptionAvailable = true
  storageMock.backend = 'gnome_libsecret'
  storageMock.encryptString.mockClear()
  storageMock.decryptString.mockClear()
})

afterEach(async () => {
  await rm(testDirectory, { recursive: true, force: true })
})

describe('encrypted Gemini key storage', () => {
  it('stores only encrypted bytes outside settings and never returns the key in its status', async () => {
    const key = 'unit-test-only-secret-not-an-api-key-0123456789'
    const status = await saveGeminiApiKey(key)
    const stored = await readFile(join(testDirectory, 'secrets', 'gemini-api-key.enc'))

    expect(status).toEqual({ configured: true, secureStorageAvailable: true })
    expect(stored.toString('utf8')).not.toContain(key)
    expect(await getGeminiApiKey()).toBe(key)
    expect(await getGeminiApiKeyStatus()).toEqual({ configured: true, secureStorageAvailable: true })
  })

  it('refuses to save a key when operating-system encryption is unavailable', async () => {
    storageMock.encryptionAvailable = false
    const key = 'unit-test-only-secret-not-an-api-key-0123456789'
    await expect(saveGeminiApiKey(key)).rejects.toThrow('Secure local storage is unavailable')
    expect(storageMock.encryptString).not.toHaveBeenCalled()
    expect(await getGeminiApiKeyStatus()).toMatchObject({ configured: false, secureStorageAvailable: false })
  })

  it('validates key shape before touching secure storage', async () => {
    await expect(saveGeminiApiKey('short')).rejects.toThrow('Enter a valid Gemini API key')
    expect(storageMock.encryptString).not.toHaveBeenCalled()
  })

  it('removes the encrypted key without exposing its value', async () => {
    await saveGeminiApiKey('unit-test-only-secret-not-an-api-key-0123456789')
    const status = await clearGeminiApiKey()
    expect(status.configured).toBe(false)
    expect(await getGeminiApiKey()).toBeNull()
  })
})
