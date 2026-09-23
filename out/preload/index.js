"use strict";
const electron = require("electron");
const desktop = {
  createProject: (name) => electron.ipcRenderer.invoke("project:create", name),
  openProject: () => electron.ipcRenderer.invoke("project:open"),
  openRecentProject: (rootPath) => electron.ipcRenderer.invoke("project:open-recent", rootPath),
  saveProject: (project) => electron.ipcRenderer.invoke("project:save", project),
  importMedia: () => electron.ipcRenderer.invoke("media:import"),
  importAudio: () => electron.ipcRenderer.invoke("media:import-audio"),
  relinkMedia: (mediaId) => electron.ipcRenderer.invoke("media:relink", mediaId),
  analyze: (project, mediaIds, jobId) => electron.ipcRenderer.invoke("project:analyze", project, mediaIds, jobId),
  analyzeVisuals: (project, mediaId, jobId, consent) => electron.ipcRenderer.invoke("media:analyze-visuals", project, mediaId, jobId, consent),
  transcribe: (project, mediaId, jobId) => electron.ipcRenderer.invoke("media:transcribe", project, mediaId, jobId),
  chat: (project, text, jobId) => electron.ipcRenderer.invoke("agent:chat", project, text, jobId),
  exportVideo: (request, jobId) => electron.ipcRenderer.invoke("export:render", request, jobId),
  cancelJob: (jobId) => electron.ipcRenderer.invoke("job:cancel", jobId),
  getSettings: () => electron.ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => electron.ipcRenderer.invoke("settings:save", settings),
  getGeminiApiKeyStatus: () => electron.ipcRenderer.invoke("gemini:key:status"),
  saveGeminiApiKey: (key) => electron.ipcRenderer.invoke("gemini:key:save", key),
  clearGeminiApiKey: () => electron.ipcRenderer.invoke("gemini:key:clear"),
  testGeminiConnection: (key) => electron.ipcRenderer.invoke("gemini:connection:test", key),
  getMediaRuntimeStatus: () => electron.ipcRenderer.invoke("media:runtime:get"),
  checkMediaRuntime: () => electron.ipcRenderer.invoke("media:runtime:check"),
  pickWhisperBinary: () => electron.ipcRenderer.invoke("settings:pick-whisper-binary"),
  pickWhisperModel: () => electron.ipcRenderer.invoke("settings:pick-whisper-model"),
  openLogs: () => electron.ipcRenderer.invoke("logs:open"),
  onJobProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    electron.ipcRenderer.on("job:progress", listener);
    return () => electron.ipcRenderer.removeListener("job:progress", listener);
  }
};
electron.contextBridge.exposeInMainWorld("desktop", desktop);
