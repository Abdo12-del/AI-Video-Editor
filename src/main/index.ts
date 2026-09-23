import { app, BrowserWindow, protocol, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkMediaRuntime } from './mediaEngine'
import { registerIpcHandlers } from './ipc'
import { initializeLogger, writeLog } from './logger'
import { registerMediaProtocol } from './mediaProtocol'

let mainWindow: BrowserWindow | null = null

protocol.registerSchemesAsPrivileged([{
  scheme: 'aivideo',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0b0f16',
    title: 'AI Video Editor',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl && url.startsWith(rendererUrl)) return
    if (!rendererUrl && url.startsWith('file://')) return
    event.preventDefault()
  })
  mainWindow.on('closed', () => { mainWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.aivideoeditor.desktop')
  await initializeLogger()
  const mediaRuntime = await checkMediaRuntime()
  await writeLog(mediaRuntime.ready ? 'info' : 'error', 'media_runtime_check', { mediaRuntime })

  if (process.argv.includes('--media-health-check')) {
    const outputArgument = process.argv.find((argument) => argument.startsWith('--media-health-check-output='))
    const outputPath = outputArgument?.slice('--media-health-check-output='.length)
    const report = JSON.stringify(mediaRuntime, null, 2)
    if (outputPath) await writeFile(resolve(outputPath), `${report}\n`, 'utf8')
    console.log(report)
    app.exit(mediaRuntime.ready ? 0 : 2)
    return
  }

  registerMediaProtocol()
  registerIpcHandlers(mediaRuntime)
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}).catch(async (error) => {
  await writeLog('error', 'application_start_failed', { error: String(error) })
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
