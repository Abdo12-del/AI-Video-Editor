# Validation status

This repository intentionally distinguishes between code-level validation and real-platform validation.

## Windows x64 installer gate

Status: NOT RUN — REQUIRES WINDOWS x64

Evidence from the current environment:

- `npm run dist:win` reached the Windows preflight step.
- FFmpeg and FFprobe were restored locally and reported as runnable.
- The installer gate still stops before packaging because `node_modules/electron/dist/electron.exe` is missing in this environment.
- This is a real environment blocker, not a mock success.

The gate must be executed on a real Windows x64 host and must include:

1. Installed app launch.
2. Project creation.
3. Video import.
4. Audio import.
5. FFprobe check.
6. Video analysis.
7. Audio analysis.
8. Video trim.
9. Audio trim.
10. Audio move.
11. Gain adjustment.
12. Mute.
13. Subtitle add.
14. Subtitle edit.
15. Short generation.
16. Preview.
17. FFmpeg export.
18. Output verification.
19. Duration verification.
20. Resolution verification.
21. Audio sync verification.
22. Source integrity verification.
23. Unicode/Arabic/space/long-path file handling.

## FFmpeg runtime gate

Status: NOT RUN — REQUIRES FFmpeg

This project contains real FFmpeg and FFprobe integration, but the Windows-installed runtime must be validated on the target machine. The repository must not treat Linux build success or JS-unit success as proof of Windows export correctness.

## Gemini Live gate

Status: NOT RUN — REQUIRES REAL GEMINI API KEY

The Gemini Live path must be executed only with a real API key and network access. The live agent scenarios remain blocked until the real key is available.

## Required behavior for future passing validation

- No production code should be marked as "passing" just because tests or Linux builds succeeded.
- A Windows x64 installer can be considered valid only after the real installed app passes the smoke workflow.
- A Gemini agent flow can be considered valid only after a real API key is used and tool calls are observed end-to-end.
- Any failing real-world validation must be fixed at the root cause rather than disabled.

## Current project state

The repository already contains a substantial implementation baseline:

- real media integration
- end-to-end editor workflow
- revision protection during agent work
- one-tool-per-response safety gate
- preserved successful edits when later steps fail
- TypeScript and build checks passing locally
- FFmpeg/FFprobe runtime verification blocked by target-platform setup

The remaining work continues from this baseline without redoing the already completed implementation.
