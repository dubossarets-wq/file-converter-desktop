const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { PDFDocument, PDFName, PDFRawStream } = require("pdf-lib");

function ffmpegBin(name) {
  var packaged = path.join(process.resourcesPath, "ffmpeg", name);
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "resources", "ffmpeg", name);
}
function pandocBin() {
  var packaged = path.join(process.resourcesPath, "pandoc", "pandoc.exe");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "resources", "pandoc", "pandoc.exe");
}
// Ghostscript needs its lib/ and Resource/ directories alongside the exe —
// resolved explicitly via -I rather than relied on as relative-path
// auto-detection, since that's fragile across dev vs packaged layouts.
function ghostscriptDir() {
  var packaged = path.join(process.resourcesPath, "ghostscript");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "resources", "ghostscript");
}

var FFMPEG_PATH = ffmpegBin("ffmpeg.exe");
var PANDOC_PATH = pandocBin();
var GS_DIR = ghostscriptDir();
var GS_PATH = path.join(GS_DIR, "bin", "gswin64c.exe");
var GS_LIB_DIR = path.join(GS_DIR, "lib");
var GS_RESOURCE_DIR = path.join(GS_DIR, "Resource");

// h264_nvenc uses the GPU's dedicated encode chip instead of the CPU —
// several times faster on a machine with a capable NVIDIA card. VP9 has no
// NVENC path on any current hardware (the chip just doesn't support it),
// so WebM always goes through the CPU encoder either way.
var CODEC_ARGS_GPU = {
  // p1 is NVENC's fastest preset — costs some compression efficiency
  // (bigger file for the same -cq) versus p4/p5, which is the right trade
  // when the ask is specifically maximum speed rather than smallest file.
  mp4: function (quality) {
    var cq = Math.round(32 - (quality / 100) * 14);
    return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "hq", "-cq", String(cq), "-c:a", "aac", "-b:a", "128k"];
  }
};
var CODEC_ARGS_CPU = {
  mp4: function (quality) {
    var crf = Math.round(32 - (quality / 100) * 14);
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", String(crf), "-c:a", "aac", "-b:a", "128k"];
  },
  // libvpx-vp9 is notoriously slow at its default effort level — cpu-used
  // (0=slowest/best .. 8=fastest) is the actual speed knob; without it,
  // WebM output is many times slower than the MP4 path for no good reason.
  webm: function (quality) {
    var crf = Math.round(45 - (quality / 100) * 30);
    return ["-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0", "-cpu-used", "5", "-deadline", "realtime", "-c:a", "libopus"];
  }
};
var MIME_BY_FORMAT = {
  mp4: "video/mp4", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime"
};
// h264_nvenc/libx264 + aac work the same regardless of which of these four
// containers the result gets muxed into — only the file extension differs.
var H264_FORMATS = ["mp4", "mkv", "avi", "mov"];

// Lossy formats map quality 1–100 to a bitrate range; lossless ones ignore
// it entirely (there's nothing to trade off).
var AUDIO_CODEC_ARGS = {
  mp3: function (quality) { return ["-c:a", "libmp3lame", "-b:a", (Math.round(96 + (quality / 100) * 224)) + "k"]; },
  aac: function (quality) { return ["-c:a", "aac", "-b:a", (Math.round(96 + (quality / 100) * 224)) + "k"]; },
  ogg: function (quality) { return ["-c:a", "libvorbis", "-b:a", (Math.round(96 + (quality / 100) * 224)) + "k"]; },
  wav: function () { return ["-c:a", "pcm_s16le"]; },
  flac: function () { return ["-c:a", "flac"]; }
};
var AUDIO_MIME = { mp3: "audio/mpeg", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac" };

var DOC_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  md: "text/markdown",
  html: "text/html"
};

// ffprobe reports duration too, but shipping a whole second static binary
// just for that doubles the app's size for no real benefit — ffmpeg itself
// already prints "Duration: HH:MM:SS.ms" to stderr when probing a file
// with -i, even without an output, so that's all this actually needs.
function getDurationSeconds(inputPath) {
  return new Promise(function (resolve) {
    var proc = spawn(FFMPEG_PATH, ["-i", inputPath]);
    var stderr = "";
    proc.stderr.on("data", function (d) { stderr += d.toString(); });
    proc.on("close", function () {
      var m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
      if (!m) return resolve(0);
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseFloat("0." + m[4]));
    });
    proc.on("error", function () { resolve(0); });
  });
}

function parseOutTimeSeconds(line) {
  var m = /out_time=(\d+):(\d+):(\d+)\.(\d+)/.exec(line);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseFloat("0." + m[4]);
}

// Same -i probe as getDurationSeconds, just reading the codec name instead
// ("Video: h264 (High) ...") — used to decide upfront whether a file even
// qualifies for the no-recode stream-copy shortcut.
function probeVideoCodec(inputPath) {
  return new Promise(function (resolve) {
    var proc = spawn(FFMPEG_PATH, ["-i", inputPath]);
    var stderr = "";
    proc.stderr.on("data", function (d) { stderr += d.toString(); });
    proc.on("close", function () {
      var m = /Video:\s*([a-zA-Z0-9_]+)/.exec(stderr);
      resolve(m ? m[1].toLowerCase() : null);
    });
    proc.on("error", function () { resolve(null); });
  });
}

ipcMain.handle("probe-video", async function (event, payload) {
  var codec = await probeVideoCodec(payload.inputPath);
  return { codec: codec };
});

function runFfmpeg(codecArgs, inputPath, outputPath, durationSeconds, jobId, event, hwaccelArgs, trim) {
  return new Promise(function (resolve, reject) {
    // -ss before -i seeks fast (skips straight to the nearest keyframe
    // before decoding anything); -t after -i is a duration relative to
    // that seek point, not an absolute end time, so it stays correct
    // regardless of where trimming starts.
    var preArgs = (hwaccelArgs || ["-hwaccel", "auto"]).slice();
    if (trim && trim.start) preArgs = preArgs.concat(["-ss", String(trim.start)]);
    var postInputArgs = [];
    if (trim && trim.duration) postInputArgs = ["-t", String(trim.duration)];
    var args = ["-y"].concat(preArgs, ["-i", inputPath], postInputArgs).concat(codecArgs, ["-progress", "pipe:1", "-nostats", outputPath]);
    var proc = spawn(FFMPEG_PATH, args);
    var stderr = "";
    var stdoutTail = "";

    proc.stdout.on("data", function (d) {
      stdoutTail += d.toString();
      var lines = stdoutTail.split("\n");
      stdoutTail = lines.pop();
      lines.forEach(function (line) {
        var t = parseOutTimeSeconds(line);
        if (t !== null && durationSeconds > 0) {
          var pct = Math.min(99, Math.round((t / durationSeconds) * 100));
          event.sender.send("job-progress", { jobId: jobId, progress: pct });
        }
      });
    });
    proc.stderr.on("data", function (d) { stderr += d.toString(); });

    proc.on("close", function (code) {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        fs.unlink(outputPath, function () {});
        reject(new Error(stderr.slice(-800) || ("ffmpeg exited with code " + code)));
      }
    });
    proc.on("error", function (err) { reject(err); });
  });
}

function computeTrim(payload, durationSeconds) {
  var start = payload.trimStart ? parseFloat(payload.trimStart) : 0;
  var end = payload.trimEnd ? parseFloat(payload.trimEnd) : 0;
  if (!start && !end) return { trim: null, effectiveDuration: durationSeconds };
  var duration = end > start ? (end - start) : 0;
  return {
    trim: { start: start || 0, duration: duration || undefined },
    effectiveDuration: duration || (durationSeconds - start) || durationSeconds
  };
}

// Runs directly against the file already on disk — no upload, no server,
// no memory ceiling beyond what the user's own machine has. Progress is
// parsed from ffmpeg's own `-progress` stream, same technique the (now
// retired) cloud backend used, just local.
ipcMain.handle("convert-video", async function (event, payload) {
  var inputPath = payload.inputPath;
  var format = payload.format;
  var quality = payload.quality;
  var jobId = payload.jobId;

  // "Extract audio only" reuses the video pipeline's trim/progress plumbing
  // but produces an MP3 instead of a re-encoded video — same source file,
  // just -vn (drop the video stream) and an audio codec.
  if (payload.audioOnly) {
    var audioOutDir = path.join(os.tmpdir(), "file-converter-desktop");
    fs.mkdirSync(audioOutDir, { recursive: true });
    var audioOutputPath = path.join(audioOutDir, jobId + ".mp3");
    var audioDuration = await getDurationSeconds(inputPath);
    var trimA = computeTrim(payload, audioDuration);
    var audioArgs = ["-vn"].concat(AUDIO_CODEC_ARGS.mp3(quality));
    var audioResultPath = await runFfmpeg(audioArgs, inputPath, audioOutputPath, trimA.effectiveDuration, jobId, event, null, trimA.trim);
    var audioStat = fs.statSync(audioResultPath);
    return { outputPath: audioResultPath, mimeType: AUDIO_MIME.mp3, size: audioStat.size };
  }

  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.mkdirSync(outDir, { recursive: true });
  var outputPath = path.join(outDir, jobId + "." + format);

  var durationSeconds = await getDurationSeconds(inputPath);
  var trimInfo = computeTrim(payload, durationSeconds);

  var resultPath;
  if (payload.noRecode && !trimInfo.trim) {
    // Stream copy only makes sense untrimmed here — trimming a copy still
    // works in ffmpeg, but combined with "no recode" the two features
    // rarely matter together, so keep this path simple and always transcode
    // when a trim is set (needed anyway for a frame-accurate cut).
    try {
      // Stream copy: no decode/encode at all, just repackages the existing
      // streams into the new container — near-instant, but only actually
      // works when the source codec is valid inside the target container
      // (e.g. H.264 into MP4). Falls through to a real transcode below if
      // the container rejects the source codec.
      resultPath = await runFfmpeg(["-c", "copy"], inputPath, outputPath, durationSeconds, jobId, event);
      var stat = fs.statSync(resultPath);
      return { outputPath: resultPath, mimeType: MIME_BY_FORMAT[format], size: stat.size };
    } catch (copyErr) {
      // fall through to the normal transcode path below
    }
  }
  if (H264_FORMATS.indexOf(format) !== -1) {
    try {
      // Decoding straight to CUDA frames (not just letting the driver pick
      // "auto") skips a decode→system-RAM→GPU round trip per frame — the
      // full pipeline stays on the GPU from decode through encode. Only
      // applied to this attempt: if it fails to init for some input, the
      // CPU fallback below uses the safer "auto" default instead.
      resultPath = await runFfmpeg(CODEC_ARGS_GPU.mp4(quality), inputPath, outputPath, trimInfo.effectiveDuration, jobId, event, ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"], trimInfo.trim);
    } catch (gpuErr) {
      // No NVIDIA GPU, driver too old, or NVENC just failed to init —
      // fall back to the software encoder rather than failing the job.
      resultPath = await runFfmpeg(CODEC_ARGS_CPU.mp4(quality), inputPath, outputPath, trimInfo.effectiveDuration, jobId, event, null, trimInfo.trim);
    }
  } else {
    resultPath = await runFfmpeg(CODEC_ARGS_CPU[format](quality), inputPath, outputPath, trimInfo.effectiveDuration, jobId, event, null, trimInfo.trim);
  }

  var stat = fs.statSync(resultPath);
  return { outputPath: resultPath, mimeType: MIME_BY_FORMAT[format], size: stat.size };
});

ipcMain.handle("convert-audio", async function (event, payload) {
  var inputPath = payload.inputPath;
  var format = payload.format;
  var quality = payload.quality;
  var jobId = payload.jobId;

  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.mkdirSync(outDir, { recursive: true });
  var outputPath = path.join(outDir, jobId + "." + format);

  var durationSeconds = await getDurationSeconds(inputPath);
  var args = ["-vn"].concat(AUDIO_CODEC_ARGS[format](quality));

  // Silence trimming and loudness normalization are separate opt-in audio
  // filters — chained together with a comma when both are on. silenceremove
  // strips quiet stretches from the start/end/middle; loudnorm targets a
  // standard broadcast loudness level (EBU R128) instead of just peak gain.
  var filters = [];
  if (payload.trimSilence) filters.push("silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.3:stop_periods=1:stop_threshold=-50dB:stop_silence=0.3");
  if (payload.normalize) filters.push("loudnorm");
  if (filters.length) args = args.concat(["-af", filters.join(",")]);

  var resultPath = await runFfmpeg(args, inputPath, outputPath, durationSeconds, jobId, event);

  var stat = fs.statSync(resultPath);
  return { outputPath: resultPath, mimeType: AUDIO_MIME[format], size: stat.size };
});

ipcMain.handle("extract-video-thumbnail", async function (event, payload) {
  var inputPath = payload.inputPath;
  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.mkdirSync(outDir, { recursive: true });
  var thumbPath = path.join(outDir, "thumb_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".jpg");

  var durationSeconds = await getDurationSeconds(inputPath);
  var seekTo = durationSeconds > 1 ? durationSeconds / 2 : 0;

  return new Promise(function (resolve) {
    var proc = spawn(FFMPEG_PATH, ["-y", "-ss", String(seekTo), "-i", inputPath, "-frames:v", "1", "-vf", "scale=160:-1", thumbPath]);
    proc.on("close", function (code) {
      if (code === 0 && fs.existsSync(thumbPath)) {
        var buffer = fs.readFileSync(thumbPath);
        fs.unlink(thumbPath, function () {});
        resolve({ buffer: buffer });
      } else {
        resolve({ buffer: null });
      }
    });
    proc.on("error", function () { resolve({ buffer: null }); });
  });
});

// GIF has no browser Canvas encoder (toBlob never supported "image/gif"),
// so this one image format routes through ffmpeg instead — a two-pass
// palette (palettegen/paletteuse) gives noticeably better quality than
// ffmpeg's default single-pass GIF palette.
ipcMain.handle("convert-image-gif", async function (event, payload) {
  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.mkdirSync(outDir, { recursive: true });
  var inPath = path.join(outDir, "gifsrc_" + payload.jobId + ".png");
  var outPath = path.join(outDir, "gif_" + payload.jobId + ".gif");
  fs.writeFileSync(inPath, Buffer.from(payload.buffer));

  return new Promise(function (resolve, reject) {
    var proc = spawn(FFMPEG_PATH, [
      "-y", "-i", inPath,
      "-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      outPath
    ]);
    var stderr = "";
    proc.stderr.on("data", function (d) { stderr += d.toString(); });
    proc.on("close", function (code) {
      fs.unlink(inPath, function () {});
      if (code === 0 && fs.existsSync(outPath)) {
        var buffer = fs.readFileSync(outPath);
        fs.unlink(outPath, function () {});
        resolve({ buffer: buffer, mimeType: "image/gif" });
      } else {
        reject(new Error(stderr.slice(-500) || "ffmpeg gif conversion failed"));
      }
    });
    proc.on("error", function (err) { fs.unlink(inPath, function () {}); reject(err); });
  });
});

// Pandoc conversions are near-instant for ordinary documents, so unlike
// video/audio this has no meaningful progress to report — just a single
// pass/fail. No PDF support: that needs a full layout engine (LibreOffice
// or a LaTeX toolchain), hundreds of MB to 1GB+ more, out of scope here.
ipcMain.handle("convert-document", async function (event, payload) {
  var inputPath = payload.inputPath;
  var format = payload.format;
  var jobId = payload.jobId;

  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.mkdirSync(outDir, { recursive: true });
  var outputPath = path.join(outDir, jobId + "." + format);

  return new Promise(function (resolve, reject) {
    var proc = spawn(PANDOC_PATH, [inputPath, "-o", outputPath, "--standalone"]);
    var stderr = "";
    proc.stderr.on("data", function (d) { stderr += d.toString(); });
    proc.on("close", function (code) {
      if (code === 0 && fs.existsSync(outputPath)) {
        var stat = fs.statSync(outputPath);
        resolve({ outputPath: outputPath, mimeType: DOC_MIME[format], size: stat.size });
      } else {
        fs.unlink(outputPath, function () {});
        reject(new Error(stderr.slice(-800) || ("pandoc exited with code " + code)));
      }
    });
    proc.on("error", function (err) { reject(err); });
  });
});

var PDF_MIME = "application/pdf";

// Quick-mode presets map straight onto Ghostscript's own distiller presets —
// resolution/quality numbers here are only used for the UI's live estimate
// and as the JPEGQ figure, since /screen etc already imply sensible
// downsample resolutions on their own.
var PDF_PRESETS = {
  screen: { pdfsettings: "/screen", dpi: 72, quality: 40 },
  ebook: { pdfsettings: "/ebook", dpi: 150, quality: 60 },
  printer: { pdfsettings: "/printer", dpi: 300, quality: 80 },
  prepress: { pdfsettings: "/prepress", dpi: 300, quality: 90 }
};

// JPEG quality in pdfwrite is controlled by QFactor (lower = better), NOT by
// -dJPEGQ: that switch belongs to the standalone jpeg device and pdfwrite
// ignores it outright — measured, every -dJPEGQ value produced a byte-identical
// file. Anchors below are Adobe's own preset QFactors, so the quick modes land
// exactly where /screen, /ebook, /printer and /prepress would.
function qualityToQFactor(quality) {
  var anchors = [[1, 2.5], [40, 1.3], [60, 0.76], [80, 0.4], [90, 0.15], [100, 0.1]];
  if (quality <= anchors[0][0]) return anchors[0][1];
  for (var i = 0; i < anchors.length - 1; i++) {
    var a = anchors[i], b = anchors[i + 1];
    if (quality <= b[0]) return a[1] + ((quality - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  }
  return anchors[anchors.length - 1][1];
}

// Builds the actual gs argument list. Presets set the PDFSETTINGS baseline,
// but the individual checkboxes still take effect on top of it — picking a
// preset and then unchecking e.g. "оптимизировать шрифты" really does turn
// font subsetting off, rather than the checkbox being decorative.
function buildPdfArgs(settings, inputPath, outputPath) {
  var preset = PDF_PRESETS[settings.mode];
  var dpi = preset ? preset.dpi : (settings.dpi || null);
  var quality = preset ? preset.quality : (settings.quality || 75);

  // -o implies -dBATCH/-dNOPAUSE and, unlike -sOutputFile, may precede the
  // -c PostScript block that carries the image dictionaries.
  var args = [
    "-I" + GS_LIB_DIR, "-I" + GS_RESOURCE_DIR,
    "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.4",
    "-dSAFER", "-o", outputPath,
    "-dPDFSETTINGS=" + (preset ? preset.pdfsettings : "/default")
  ];

  var postScript = "";
  if (settings.optimizeImages !== false) {
    // Without this, gs copies existing JPEGs through untouched whenever no
    // downsampling is required, and every quality setting silently does
    // nothing — this is what made the quality slider decorative.
    args.push("-dPassThroughJPEGImages=false", "-dPassThroughJPXImages=false");

    if (dpi) {
      args.push(
        "-dDownsampleColorImages=true", "-dDownsampleGrayImages=true", "-dDownsampleMonoImages=true",
        "-dColorImageDownsampleType=/Bicubic", "-dGrayImageDownsampleType=/Bicubic",
        // Default threshold is 1.5: an image only 1.4× over the target DPI
        // would be left alone, so an explicitly chosen DPI looked ignored.
        "-dColorImageDownsampleThreshold=1.0", "-dGrayImageDownsampleThreshold=1.0",
        "-dColorImageResolution=" + dpi, "-dGrayImageResolution=" + dpi, "-dMonoImageResolution=" + Math.max(dpi, 300)
      );
    } else {
      args.push("-dDownsampleColorImages=false", "-dDownsampleGrayImages=false", "-dDownsampleMonoImages=false");
    }

    if (settings.imageFormat === "png") {
      args.push("-dAutoFilterColorImages=false", "-dAutoFilterGrayImages=false", "-dColorImageFilter=/FlateEncode", "-dGrayImageFilter=/FlateEncode");
    } else {
      args.push("-dAutoFilterColorImages=false", "-dAutoFilterGrayImages=false", "-dColorImageFilter=/DCTEncode", "-dGrayImageFilter=/DCTEncode");
      var dict = "<</QFactor " + qualityToQFactor(quality).toFixed(3) +
        " /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1]>>";
      postScript = "<</ColorImageDict " + dict + " /GrayImageDict " + dict + " >> setdistillerparams";
    }
  } else {
    args.push("-dDownsampleColorImages=false", "-dDownsampleGrayImages=false", "-dDownsampleMonoImages=false");
  }

  var compressStreams = settings.compressStreams !== false;
  args.push("-dCompressStreams=" + compressStreams, "-dCompressPages=" + compressStreams);
  var optimizeFonts = settings.optimizeFonts !== false;
  args.push("-dCompressFonts=" + optimizeFonts, "-dSubsetFonts=" + optimizeFonts);
  if (settings.fastWebView) args.push("-dFastWebView=true");

  if (postScript) args.push("-c", postScript);
  args.push("-f", inputPath);
  return args;
}

function runGhostscript(args, jobId, event, totalPages) {
  return new Promise(function (resolve, reject) {
    var proc = spawn(GS_PATH, args);
    var stderr = "";
    var stdoutTail = "";

    // No -progress pipe like ffmpeg has — but without -dQUIET, gs prints
    // "Page N" to stdout as each page finishes, which is enough for a real
    // (not simulated) percentage against the page count from inspect-pdf.
    proc.stdout.on("data", function (d) {
      stdoutTail += d.toString();
      var lines = stdoutTail.split("\n");
      stdoutTail = lines.pop();
      lines.forEach(function (line) {
        var m = /^Page (\d+)/.exec(line);
        if (m && totalPages > 0 && jobId) {
          var pct = Math.min(99, Math.round((parseInt(m[1], 10) / totalPages) * 100));
          event.sender.send("job-progress", { jobId: jobId, progress: pct });
        }
      });
    });
    proc.stderr.on("data", function (d) { stderr += d.toString(); });

    proc.on("close", function (code) {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-800) || ("gs exited with code " + code)));
    });
    proc.on("error", function (err) { reject(err); });
  });
}

// Detects "is encrypted" by message text rather than `instanceof
// EncryptedPDFError` — verified against the installed pdf-lib build that the
// thrown error does NOT satisfy that instanceof check even though it's the
// exact documented encrypted-PDF message, so the string match is the
// reliable signal here, not the exported error class.
function isEncryptedPdfError(e) {
  return !!(e && e.message && e.message.indexOf("is encrypted") !== -1);
}

// Shared by inspect-pdf (pre-flight, before the user even hits "Применить")
// and the post-compression metadata pass — walks every indirect object once
// and picks out image XObjects. Width/Height come straight from the stream
// dict, no pixel decoding needed.
async function readPdfStructure(buffer) {
  var doc = await PDFDocument.load(buffer, { updateMetadata: false });
  var images = [];
  for (var entry of doc.context.enumerateIndirectObjects()) {
    var obj = entry[1];
    if (obj instanceof PDFRawStream) {
      var subtype = obj.dict.get(PDFName.of("Subtype"));
      if (subtype && subtype.toString() === "/Image") {
        var w = obj.dict.get(PDFName.of("Width"));
        var h = obj.dict.get(PDFName.of("Height"));
        images.push({
          width: w && w.asNumber ? w.asNumber() : 0,
          height: h && h.asNumber ? h.asNumber() : 0,
          bytes: obj.contents.length
        });
      }
    }
  }
  return { doc: doc, images: images };
}

// Pre-flight inspection — page count, embedded-image sizes for the client's
// own size estimate, and password/corruption detection up front so the UI
// can show a friendly Russian error immediately instead of waiting on a
// doomed Ghostscript pass.
ipcMain.handle("inspect-pdf", async function (event, payload) {
  var buf;
  try {
    buf = fs.readFileSync(payload.inputPath);
  } catch (e) {
    return { error: "corrupted" };
  }
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    return { error: "unsupported" };
  }
  try {
    var structure = await readPdfStructure(buf);
    return {
      pageCount: structure.doc.getPageCount(),
      imageCount: structure.images.length,
      images: structure.images,
      totalBytes: buf.length
    };
  } catch (e) {
    if (isEncryptedPdfError(e)) return { error: "encrypted" };
    return { error: "corrupted" };
  }
});

// Metadata/hidden-data stripping runs on the INPUT, before Ghostscript — not
// after it. pdf-lib re-serializes the whole file when it saves, which drops
// the /Linearized structure gs had just built, so running it last silently
// cancelled "подготовить для быстрой загрузки" (measured: /Linearized true ->
// false). Running it first also lets gs garbage-collect the objects pdf-lib
// orphans, instead of carrying them into the result.
async function stripPdfExtras(inputPath, outputPath, settings) {
  var doc = await PDFDocument.load(fs.readFileSync(inputPath), { updateMetadata: false });
  if (settings.stripMetadata) {
    doc.setTitle(""); doc.setAuthor(""); doc.setSubject("");
    doc.setKeywords([]); doc.setProducer(""); doc.setCreator("");
    doc.catalog.delete(PDFName.of("Metadata"));
  }
  if (settings.stripHidden) {
    // Document-level JavaScript and auto-run actions survive pdfwrite, so
    // they have to go here; file attachments gs drops on its own.
    doc.catalog.delete(PDFName.of("Names"));
    doc.catalog.delete(PDFName.of("OpenAction"));
    doc.catalog.delete(PDFName.of("AA"));
  }
  fs.writeFileSync(outputPath, await doc.save());
}

ipcMain.handle("compress-pdf", async function (event, payload) {
  var inputPath = payload.inputPath;
  var settings = payload.settings;
  var jobId = payload.jobId;

  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.mkdirSync(outDir, { recursive: true });
  var outputPath = path.join(outDir, jobId + ".pdf");
  var strippedPath = null;

  var gsInput = inputPath;
  if (settings.stripMetadata || settings.stripHidden) {
    try {
      strippedPath = path.join(outDir, jobId + "_pre.pdf");
      await stripPdfExtras(inputPath, strippedPath, settings);
      gsInput = strippedPath;
    } catch (e) {
      // Best-effort: an unusual structure that pdf-lib can't round-trip
      // shouldn't cost the user the actual compression, so fall back to
      // compressing the original untouched.
      strippedPath = null;
      gsInput = inputPath;
    }
  }

  try {
    await runGhostscript(buildPdfArgs(settings, gsInput, outputPath), jobId, event, payload.pageCount || 0);
  } catch (e) {
    if (strippedPath) fs.unlink(strippedPath, function () {});
    throw new Error("Не удалось выполнить сжатие: " + e.message.slice(0, 300));
  }
  if (strippedPath) fs.unlink(strippedPath, function () {});
  if (!fs.existsSync(outputPath)) {
    throw new Error("Не удалось выполнить сжатие");
  }

  // Re-encoding can legitimately come out bigger than the source (asking for
  // higher quality than the images were stored at, mostly) — handing back a
  // bigger file from a tool called "сжатие" is worse than doing nothing, so
  // keep the original instead, the same rule the image pipeline follows.
  // Not when metadata or hidden data was meant to be removed, though: giving
  // back the untouched original would quietly hand back the JavaScript and
  // author fields the user asked to strip, and that matters more than bytes.
  var stat = fs.statSync(outputPath);
  var originalSize = fs.statSync(inputPath).size;
  var mustKeepProcessed = settings.stripMetadata || settings.stripHidden;
  if (stat.size >= originalSize && !mustKeepProcessed) {
    fs.copyFileSync(inputPath, outputPath);
    return { outputPath: outputPath, mimeType: PDF_MIME, size: originalSize, keptOriginal: true };
  }
  return { outputPath: outputPath, mimeType: PDF_MIME, size: stat.size };
});

// For images the renderer already has the bytes as a Blob (Canvas work
// happens entirely client-side) — a normal buffer-over-IPC save is fine
// there since those are small. Video/audio/document output instead lives
// on disk from the ffmpeg/pandoc step above; a multi-GB file sent as one
// IPC message is what caused the "error right after 100%" bug (Electron's
// IPC has to structured-clone the whole payload, which chokes on files of
// that size), so those get copied straight from temp path to the chosen
// destination — no bytes ever cross the IPC boundary.
// Without an explicit filter, Windows' save dialog only offers "All Files"
// and won't re-add an extension if the user edits/replaces the suggested
// filename (e.g. types "8к" over "8k.webp") — the file then saves with no
// extension at all. Passing a filter tied to the actual format fixes that
// for the normal case; savePathWithExt() is a hard backstop in case the
// user still picks "All Files" and strips it anyway.
function saveDialogFilters(filename) {
  var ext = path.extname(filename).replace(/^\./, "");
  if (!ext) return undefined;
  return [{ name: ext.toUpperCase() + " (*." + ext + ")", extensions: [ext] }];
}

function savePathWithExt(filePath, defaultFilename) {
  if (path.extname(filePath)) return filePath;
  var ext = path.extname(defaultFilename);
  return ext ? filePath + ext : filePath;
}

ipcMain.handle("save-file", async function (event, payload) {
  var win = BrowserWindow.fromWebContents(event.sender);
  var result = await dialog.showSaveDialog(win, {
    defaultPath: payload.defaultFilename,
    filters: saveDialogFilters(payload.defaultFilename)
  });
  if (result.canceled || !result.filePath) return { saved: false };
  var filePath = savePathWithExt(result.filePath, payload.defaultFilename);
  fs.writeFileSync(filePath, Buffer.from(payload.buffer));
  return { saved: true, path: filePath };
});

ipcMain.handle("save-output-file", async function (event, payload) {
  var win = BrowserWindow.fromWebContents(event.sender);
  var result = await dialog.showSaveDialog(win, {
    defaultPath: payload.defaultFilename,
    filters: saveDialogFilters(payload.defaultFilename)
  });
  if (result.canceled || !result.filePath) return { saved: false };
  if (!fs.existsSync(payload.outputPath)) throw new Error("SOURCE_MISSING");
  var filePath = savePathWithExt(result.filePath, payload.defaultFilename);
  // The temp result is deliberately left in place: the row stays "готово"
  // with an active save button, so saving the same result a second time
  // (another folder, another name) has to keep working. Deleting it here
  // made every repeat save fail with ENOENT. before-quit wipes the dir.
  await fs.promises.copyFile(payload.outputPath, filePath);
  return { saved: true, path: filePath };
});

ipcMain.handle("choose-folder", async function (event) {
  var win = BrowserWindow.fromWebContents(event.sender);
  var result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths.length) return { chosen: false };
  return { chosen: true, folderPath: result.filePaths[0] };
});

function uniqueDestPath(folderPath, filename) {
  var ext = path.extname(filename);
  var base = path.basename(filename, ext);
  var dest = path.join(folderPath, filename);
  var i = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(folderPath, base + " (" + i + ")" + ext);
    i++;
  }
  return dest;
}

// Batch "save all" — one folder picked up front, then every file lands
// there with no further per-file prompts. Mirrors save-file/save-output-file
// (buffer for images, path-copy for video/audio/documents) but writes
// straight into the chosen folder instead of opening a dialog each time.
ipcMain.handle("save-to-folder", async function (event, payload) {
  // A missing source and a missing destination folder both surface as plain
  // ENOENT from copyFile, which produced a confidently wrong message ("файл
  // не найден" when it was really the folder). Check them apart instead.
  if (payload.outputPath && !fs.existsSync(payload.outputPath)) {
    throw new Error("SOURCE_MISSING");
  }
  if (!fs.existsSync(payload.folderPath)) {
    // A remembered default folder can be renamed, deleted or living on a
    // drive that's no longer attached — recreate it when that's possible.
    try {
      fs.mkdirSync(payload.folderPath, { recursive: true });
    } catch (e) {
      throw new Error("FOLDER_UNAVAILABLE");
    }
  }
  var dest = uniqueDestPath(payload.folderPath, payload.filename);
  if (payload.outputPath) {
    // Same as save-output-file: the temp result stays put so the file can be
    // saved again afterwards.
    await fs.promises.copyFile(payload.outputPath, dest);
  } else {
    fs.writeFileSync(dest, Buffer.from(payload.buffer));
  }
  return { saved: true, path: dest };
});

// Anything left in the temp output dir (converted but never saved, or the
// app was closed mid-job) would otherwise accumulate on disk indefinitely.
app.on("before-quit", function () {
  var outDir = path.join(os.tmpdir(), "file-converter-desktop");
  fs.rm(outDir, { recursive: true, force: true }, function () {});
});

function createWindow() {
  var win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0E1315",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

app.whenReady().then(function () {
  createWindow();
  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});
