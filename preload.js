const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  getFilePath: function (file) {
    return webUtils.getPathForFile(file);
  },
  convertVideo: function (payload) {
    return ipcRenderer.invoke("convert-video", payload);
  },
  convertAudio: function (payload) {
    return ipcRenderer.invoke("convert-audio", payload);
  },
  convertDocument: function (payload) {
    return ipcRenderer.invoke("convert-document", payload);
  },
  onJobProgress: function (callback) {
    ipcRenderer.on("job-progress", function (event, data) { callback(data); });
  },
  saveFile: function (buffer, defaultFilename) {
    return ipcRenderer.invoke("save-file", { buffer: buffer, defaultFilename: defaultFilename });
  },
  saveOutputFile: function (outputPath, defaultFilename) {
    return ipcRenderer.invoke("save-output-file", { outputPath: outputPath, defaultFilename: defaultFilename });
  },
  chooseFolder: function () {
    return ipcRenderer.invoke("choose-folder");
  },
  saveToFolder: function (payload) {
    return ipcRenderer.invoke("save-to-folder", payload);
  },
  extractVideoThumbnail: function (inputPath) {
    return ipcRenderer.invoke("extract-video-thumbnail", { inputPath: inputPath });
  },
  convertImageGif: function (payload) {
    return ipcRenderer.invoke("convert-image-gif", payload);
  },
  inspectPdf: function (inputPath) {
    return ipcRenderer.invoke("inspect-pdf", { inputPath: inputPath });
  },
  compressPdf: function (payload) {
    return ipcRenderer.invoke("compress-pdf", payload);
  }
});
