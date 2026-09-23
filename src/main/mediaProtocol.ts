import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { getActiveProject } from './projectStore'

export function registerMediaProtocol(): void {
  protocol.handle('aivideo', async (request) => {
    try {
      const url = new URL(request.url)
      const mediaId = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(mediaId)) return new Response('Not found', { status: 404 })
      const asset = getActiveProject()?.media.find((item) => item.id === mediaId)
      if (!asset) return new Response('Not found', { status: 404 })
      const path = url.hostname === 'media' ? asset.filePath : url.hostname === 'thumbnail' ? asset.thumbnailPath : url.hostname === 'waveform' ? asset.waveformPath : undefined
      if (!path || !existsSync(path)) return new Response('Media unavailable', { status: 404 })
      const size = statSync(path).size
      const extension = extname(path).toLowerCase()
      const mime = extension === '.mp4' || extension === '.m4v' ? 'video/mp4'
        : extension === '.mov' ? 'video/quicktime'
          : extension === '.webm' ? 'video/webm'
            : extension === '.mkv' ? 'video/x-matroska'
              : extension === '.avi' ? 'video/x-msvideo'
                : extension === '.mp3' ? 'audio/mpeg'
                  : extension === '.wav' ? 'audio/wav'
                    : extension === '.m4a' ? 'audio/mp4'
                      : extension === '.aac' ? 'audio/aac'
                        : extension === '.flac' ? 'audio/flac'
                          : extension === '.ogg' ? 'audio/ogg'
                            : extension === '.opus' ? 'audio/ogg; codecs=opus'
                              : extension === '.wma' ? 'audio/x-ms-wma'
                                : extension === '.aiff' || extension === '.aif' ? 'audio/aiff'
                                  : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
                                    : extension === '.png' ? 'image/png'
                                      : 'application/octet-stream'
      const commonHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=0'
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...commonHeaders, 'Content-Length': String(size) } })
      const range = request.headers.get('range')
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/)
        if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        const suffixLength = Number(match[2])
        const start = match[1] ? Number(match[1]) : Math.max(0, size - suffixLength)
        const end = match[2] && match[1] ? Math.min(size - 1, Number(match[2])) : size - 1
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        }
        const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
        return new Response(stream, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`
          }
        })
      }
      const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
      return new Response(stream, { status: 200, headers: { ...commonHeaders, 'Content-Length': String(size) } })
    } catch (error) {
      console.error('Media protocol error', error)
      return new Response('Unable to read media', { status: 500 })
    }
  })
}
