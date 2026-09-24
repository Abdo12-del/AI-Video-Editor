# Open Source Review — AI Video Editor

Date: 2026-09-24. Scope: every significant internal tool vs. maintained open-source alternatives.
Rule: integrate only what is **clearly better**; never add a dependency for fame.

## Decision table

| Function | Current implementation | OSS evaluated | Winner | License | Windows | Decision |
|---|---|---|---|---|---|---|
| FFmpeg control | Raw `child_process` spawn of `ffmpeg-static`/`ffprobe-static` | `fluent-ffmpeg` (**archived May 2025, deprecated**), `ffmpeg.wasm` (browser-only, dropped Node) | Current | — | نعم | Keep Current |
| Scene detection | FFmpeg `select='gt(scene,0.34)'` + showinfo parse | PySceneDetect (BSD-3, Python + OpenCV sidecar) | Current | — | نعم | Keep Current |
| Frames / thumbnails / metadata | Raw FFmpeg/ffprobe, direct arg building | Same core; no maintained wrapper adds value | Current | — | نعم | Keep Current |
| Waveform | FFmpeg `showwavespic` PNG | `audiowaveform` (**GPL — excluded**), wavesurfer.js (display only, needs peaks pipeline) | Current | — | نعم | Keep Current |
| Silence / audio levels | `silencedetect` + `volumedetect` parse | Same core | Current | — | نعم | Keep Current |
| Speech activity (VAD) | None (silence + Whisper cover it) | Silero VAD (MIT) + `onnxruntime-node` (~50 MB native) | Current | MIT | نعم | Keep Current (defer; marginal value, heavy dep) |
| Beat detection | None | aubio (**GPL — excluded**), Essentia (**AGPL parts — excluded**), no strong permissive JS option | None | — | — | Keep (no feature; no suitable OSS) |
| Speech-to-text | User-provided `whisper.cpp` binary, `-oj` JSON + token offsets → words | `whisper.cpp` (MIT, v1.9.3 Aug 2026, native, word timestamps) = current; `faster-whisper` (MIT but Python runtime); `transformers.js` (Apache-2.0 but segment-only timestamps, main-thread blocking, large downloads, weaker) | Current | MIT | نعم | Keep Current |
| Visual understanding | Consented Gemini Vision stills + custom evidence ranker | MediaPipe `tasks-vision` (Apache-2.0, active, but browser env + CDN model downloads); `@vladmandic/human` (TF.js, heavy); `face-api.js` (dead, 6y) | Current | — | نعم | Keep Current |
| OCR (on-screen text) | Via Gemini Vision (consented) | `tesseract.js` v7 (Apache-2.0, TS, slow-but-alive maintenance) | OSS (future) | Apache-2.0 | نعم | **Defer** — real candidate for offline OCR; needs traineddata bundling + packaging work, Arabic accuracy mediocre |
| Face / person detection | None | MediaPipe face detector (Apache-2.0, WASM, CDN models, no official Node support) | None yet | Apache-2.0 | يحتاج تعديلات | Defer (architecture mismatch: offline-first Electron main) |
| **Smart crop / reframing** | **Center crop only** (`scale…:increase,crop=W:H`) | `smartcrop.js` (MIT, 13k★, stable algorithm) + FFmpeg `rawvideo` RGBA (no decode lib needed) | **OSS** | MIT | نعم | **INTEGRATE** ✅ |
| Subtitle file import | None (manual + transcription only) | `@plussub/srt-vtt-parser` (MIT, TypeScript, zero-dep) | **OSS** | MIT | نعم | **INTEGRATE** ✅ (new feature, engine only) |
| Subtitle model / styling / burn-in | Internal `TranscriptSegment` + ASS burn-in | Current UI + model are good; libs add nothing | Current | — | نعم | Keep Current |
| Timeline UI | Custom React (drag, zoom, playhead, trim, split) | `Ektie/react-video-timeline-editor` (**AGPL — excluded**), OpenChatCut (**AGPL — excluded**), Remotion/WebCodecs editors (MIT but wholly different render architecture) | Current | — | نعم | Keep Current |
| Effects / transitions | None (straight concat) | WebAV (MIT but browser WebCodecs; wrong layer — export is FFmpeg) | Current | — | نعم | Keep Current (future: FFmpeg `xfade`, no dep needed) |
| Agent loop / tool calling | Custom Gemini REST loop + registry + approvals | Vercel AI SDK (Apache-2.0, very active) — full rewrite, fights the approval/session design; Gemini stays provider either way | Current | Apache-2.0 | نعم | Keep Current |
| Conversation state | Custom `ConversationSession` (tested) | XState (MIT, zero-dep, active) — rewrite for moderate gain | Current | MIT | نعم | Keep Current (revisit if state complexity grows) |
| Undo / redo / history | Snapshot-based, depth 50, tested | immer / zundo (marginal; snapshots fit the doc model) | Current | — | نعم | Keep Current |
| Autosave / recovery | Renderer autosave exists | No library needed (trivial, app-specific) | Current | — | نعم | Keep Current |

## License exclusions (do not integrate into the commercial desktop build)

- `audiowaveform` — GPL (waveform).
- `aubio` — GPL (beat/onset).
- Essentia — AGPL-licensed parts (audio analysis).
- `Ektie/react-video-timeline-editor`, OpenChatCut — AGPL (timeline).
- `ultralytics` (YOLOv8) — AGPL (noted during research; not adopted).
- `fluent-ffmpeg` — not a license issue; **archived/deprecated**, technically unfit.

## Integration gate (rule 13) — the two adoptions

### 1. `smartcrop.js` → content-aware reframing

- Better than current? **نعم** — center crop loses subjects in 9:16; saliency-based crop is a genuine quality upgrade.
- License OK for commercial desktop? **نعم** — MIT.
- Windows? **نعم** — pure JS, zero dependencies, no binaries. Works in Electron main on FFmpeg-extracted `rawvideo` RGBA bytes.
- Electron / TypeScript / Node? **نعم** — ships types via `@types/smartcrop`? No: package has no bundled types; a 10-line local `.d.ts` covers the used surface. (Verified at integration time.)
- App size growth? **لا** — ~30 KB, zero deps.
- More complexity? **Minimal** — one adapter (`CropPlannerProvider` → `SmartCropProvider`) + temporal smoothing; center crop stays as fallback.
- Real value? **نعم** — every 9:16/1:1 Short export improves.

### 2. `@plussub/srt-vtt-parser` → SRT/VTT subtitle import

- Better than current? **نعم** — there is no import parser; hand-rolling SRT/VTT edge cases (BOM, commas, cue settings, multiline) is reinventing a frozen format.
- License OK? **نعم** — MIT.
- Windows / Electron / TS / Node? **نعم** — TypeScript, zero dependencies, pure string parsing.
- App size growth? **لا** — a few KB.
- More complexity? **Minimal** — one adapter (`SubtitleImportProvider`) + one IPC handler + import button; goes through existing `commitEdit` (undo-safe).
- Real value? **نعم** — users can import existing subtitle files instead of retyping.

## Security notes (rule 15)

- Both adopted packages: **zero dependencies**, pure computation on local data, no network, no fs access, no binaries, no telemetry. Verified via `npm view <pkg> dependencies` at install time.
- Rejected heavy-native options (`onnxruntime-node`, OpenCV bindings, Python sidecars) partly on supply-chain/size grounds.
- FFmpeg/Whisper remain executed local binaries with existing `runCommand` sandboxing (timeouts, job cancellation, no shell).

## Integration log (rule 18)

1. **`smartcrop@2.0.5` (MIT, zero deps)** — integrated 2026-09-24.
   - Adapter: `src/main/cropPlanner.ts` (`CropPlannerProvider` → `SmartCropProvider` + `CenterCropProvider` fallback, Node `imageOperations`, temporal smoothing, FFmpeg offset mapping) + local `src/types/smartcrop.d.ts` (package ships types but no `types` pointer).
   - Wiring: `extractRawFrameAt` + per-clip `crop=W:H:X:Y` in `renderExport`; any failure keeps the previous centered crop.
   - Tests: `src/main/cropPlanner.test.ts` (7 tests, real engine on synthetic frames). Full suite 204 green, both typechecks clean, `npm run build` clean. Agent tools, UI flows, and undo untouched (export path only).
2. **`@plussub/srt-vtt-parser@2.0.5` (MIT, zero deps)** — integrated 2026-09-24.
   - Adapter: `src/main/subtitleImport.ts` (`SubtitleImportProvider` → `PlussubSubtitleParser`, BOM/cue-settings/tag handling, ms→s validation, 5 MB / 2000-entry caps).
   - Wiring: `projectStore.importSubtitleFile` (dialog) → `subtitles:import` IPC → preload → `importSubtitles` in `src/shared/project.ts` (single undoable edit) → Import button in Subtitle Editor + ar/en/fr strings.
   - Tests: `src/main/subtitleImport.test.ts` (5 tests, real parser) + `importSubtitles` case in `src/shared/timeline.test.ts`. Full suite 204 green.
   - Note: adapter pre-strips VTT cue settings — the lib misreads end timestamps with trailing settings (`to: null`); covered by test.

Verification status:
- `npm run typecheck` ✅ · `npm test` ✅ (204 passed, 3 pre-existing skips) · `npm run build` ✅
- `npm run test:media` → **NOT RUN — no runnable FFmpeg in this Linux sandbox** (`ffmpeg-static` binary not downloaded, no system ffmpeg; failure is in the test `beforeAll` setup, pre-existing and unrelated to these changes). Must run on Windows (`test:media` covers the export path incl. smart crop).
- `npm run test:live-agent` → NOT RUN (needs a real API key; agent tools were not modified).

## Sources checked (rule 21 — real lookups, Sep 2026)

- `fluent-ffmpeg` archived notice (May 22, 2025) + `ffmpeg.wasm` Node-support issue.
- PySceneDetect repo (BSD-3-Clause, ~5.1k★).
- `whisper.cpp` (MIT, ggml-org, v1.9.3 Aug 2026) vs `faster-whisper` (MIT, Python) vs `transformers.js` Whisper comparison (segment-level timestamps, main-thread).
- `smartcrop.js` (MIT, jwagner, 13k★, updated Mar 2024) + npm (2.0.5, MIT).
- `jpeg-js` (BSD-3) — evaluated then **not needed** (rawvideo path chosen instead).
- `@plussub/srt-vtt-parser` repo + npm (MIT, TS, zero-dep, 2.0.5).
- `@mediapipe/tasks-vision` npm (Apache-2.0, 0 deps, 34.8 MB, published Apr 2026).
- `tesseract.js` npm (Apache-2.0, v7.0.0) + core security (0 vulns).
- Silero VAD (MIT) licensing notes; `@vladmandic/human` vs dead `face-api.js`.
- Vercel `ai` repo LICENSE (Apache-2.0); XState npm (MIT, zero-dep).
- Timeline: Ektie (AGPL), OpenChatCut (AGPL), Remotion-based MIT editors (arch mismatch); WebAV (MIT, browser WebCodecs).
