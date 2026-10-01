(function (root) {
  const SOURCES = [
    { kind: "invidious", base: "https://invidious.f5.si" },
    { kind: "piped", base: "https://api.piped.private.coffee" },
    { kind: "piped", base: "https://pipedapi.kavin.rocks" },
    { kind: "piped", base: "https://pipedapi.adminforge.de" },
  ];

  const streamCache = new Map();
  let mp4boxPromise = null;

  function loadMp4Box() {
    if (root.MP4Box) return Promise.resolve(root.MP4Box);
    if (mp4boxPromise) return mp4boxPromise;
    mp4boxPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/dist/mp4box.all.min.js";
      script.onload = () => (root.MP4Box ? resolve(root.MP4Box) : reject(new Error("MP4Box failed to load.")));
      script.onerror = () => reject(new Error("Could not load the MP4 demuxer."));
      document.head.append(script);
    });
    return mp4boxPromise;
  }

  function cancelled(ctx) {
    return ctx.gate && ctx.gate.on === false;
  }

  async function fetchStreams(videoId) {
    if (streamCache.has(videoId)) return streamCache.get(videoId);
    const errors = [];
    const found = await Promise.all(SOURCES.map(async (source) => {
      const path = source.kind === "piped"
        ? source.base + "/streams/" + encodeURIComponent(videoId)
        : source.base + "/api/v1/videos/" + encodeURIComponent(videoId);
      try {
        const response = await fetch(path, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) {
          errors.push(source.base + " → " + response.status);
          return null;
        }
        const data = await response.json();
        const normalized = source.kind === "piped" ? normalizePiped(data) : normalizeInvidious(data);
        if (!normalized.audioUrl && !normalized.progressiveUrl && !normalized.videoOnlyUrl && !normalized.preview) {
          errors.push(source.base + " → empty");
          return null;
        }
        normalized.kind = source.kind;
        return normalized;
      } catch (error) {
        errors.push(source.base + " → " + (error && error.message ? error.message : "failed"));
        return null;
      }
    }));
    const usable = found.filter(Boolean);
    if (!usable.length) throw new Error("No stream metadata. " + errors.join("; "));
    const piped = usable.find((item) => item.kind === "piped" && (item.progressiveUrl || item.audioUrl));
    const invidious = usable.find((item) => item.kind === "invidious");
    const merged = Object.assign({}, invidious || {}, piped || usable[0]);
    if (invidious && invidious.preview) merged.preview = invidious.preview;
    if (piped) {
      merged.progressiveUrl = piped.progressiveUrl || merged.progressiveUrl;
      merged.audioUrl = piped.audioUrl || merged.audioUrl;
      merged.videoOnlyUrl = piped.videoOnlyUrl || merged.videoOnlyUrl;
      if (piped.preview) merged.preview = piped.preview;
    }
    streamCache.set(videoId, merged);
    return merged;
  }

  function normalizeInvidious(data) {
    const adaptive = data.adaptiveFormats || [];
    const audio = adaptive
      .filter((item) => /^audio/i.test(item.type || ""))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const video = closestTo360(
      adaptive.filter((item) => /video\/mp4/i.test(item.type || "")),
      "qualityLabel"
    );
    const progressive = closestTo360(
      (data.formatStreams || []).filter((item) => /mp4/i.test(item.container || "")),
      "qualityLabel"
    );
    return {
      title: data.title || "",
      duration: Number(data.lengthSeconds) || 0,
      progressiveUrl: progressive && progressive.url,
      audioUrl: (audio && audio.url) || (progressive && progressive.url) || "",
      videoOnlyUrl: video && video.url,
      preview: pickPreview(data.storyboards || []),
    };
  }

  function normalizePiped(data) {
    const progressive = closestTo360(
      (data.videoStreams || []).filter((stream) => !stream.videoOnly && /mp4/i.test(stream.mimeType || stream.format || "")),
      "quality"
    );

    const audioOnly = (data.audioStreams || [])
      .slice()
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    const videoOnly = closestTo360(
      (data.videoStreams || []).filter((stream) => stream.videoOnly && /mp4/i.test(stream.mimeType || "")),
      "quality"
    );

    const preview = pickPreview(data.previewFrames || data.storyboards || []);

    return {
      title: data.title || "",
      duration: Number(data.duration) || 0,
      progressiveUrl: progressive && progressive.url,
      audioUrl: (audioOnly && audioOnly.url) || (progressive && progressive.url) || "",
      videoOnlyUrl: videoOnly && videoOnly.url,
      preview: preview,
      source: "piped",
    };
  }

  function qualityRank(value) {
    const match = String(value || "").match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function closestTo360(list, key) {
    if (!list.length) return null;
    return list.slice().sort((a, b) => Math.abs(qualityRank(a[key]) - 360) - Math.abs(qualityRank(b[key]) - 360))[0];
  }

  function pickPreview(list) {
    const normalized = list.map(normalizePreview).filter(Boolean);
    if (!normalized.length) return null;
    normalized.sort((a, b) => {
      const interval = a.durationPerFrame - b.durationPerFrame;
      if (Math.abs(interval) > 400) return interval;
      return (b.frameWidth * b.frameHeight) - (a.frameWidth * a.frameHeight);
    });
    return normalized[0];
  }

  function normalizePreview(entry) {
    if (!entry) return null;
    if (Array.isArray(entry.urls) && entry.urls.length) {
      return {
        urls: entry.urls.slice(),
        frameWidth: Number(entry.frameWidth) || 160,
        frameHeight: Number(entry.frameHeight) || 90,
        totalCount: Number(entry.totalCount) || 0,
        durationPerFrame: Number(entry.durationPerFrame) || 1000,
        framesPerPageX: Number(entry.framesPerPageX) || 1,
        framesPerPageY: Number(entry.framesPerPageY) || 1,
      };
    }
    if (entry.templateUrl || entry.url) {
      const framesPerPageX = Number(entry.storyboardWidth || entry.framesPerPageX) || 10;
      const framesPerPageY = Number(entry.storyboardHeight || entry.framesPerPageY) || 10;
      const storyboardCount = Number(entry.storyboardCount) || 1;
      const template = entry.templateUrl || entry.url;
      const urls = [];
      for (let index = 0; index < storyboardCount; index += 1) {
        urls.push(String(template).replace("$M", String(index)).replace("M$M", "M" + index));
      }
      return {
        urls: urls,
        frameWidth: Number(entry.width || entry.frameWidth) || 160,
        frameHeight: Number(entry.height || entry.frameHeight) || 90,
        totalCount: Number(entry.count || entry.totalCount) || urls.length * framesPerPageX * framesPerPageY,
        durationPerFrame: Number(entry.interval || entry.durationPerFrame) || 1000,
        framesPerPageX: framesPerPageX,
        framesPerPageY: framesPerPageY,
      };
    }
    return null;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Storyboard sheet failed to load."));
      image.src = url;
    });
  }

  async function loadPreviewSheets(preview) {
    const sheets = [];
    for (const url of preview.urls) {
      sheets.push(await loadImage(url));
    }
    return sheets;
  }

  function frameSource(preview, sheets, frameIndex) {
    const perPage = preview.framesPerPageX * preview.framesPerPageY;
    const page = Math.floor(frameIndex / perPage);
    const local = frameIndex % perPage;
    const col = local % preview.framesPerPageX;
    const row = Math.floor(local / preview.framesPerPageX);
    const sheet = sheets[Math.min(page, sheets.length - 1)];
    return {
      sheet: sheet,
      sx: col * preview.frameWidth,
      sy: row * preview.frameHeight,
      sw: preview.frameWidth,
      sh: preview.frameHeight,
    };
  }

  function createTransport(onPlay, onPause, onSeek) {
    const bar = document.createElement("div");
    bar.className = "transport";
    const play = button("Play", onPlay);
    const pause = button("Pause", onPause);
    const back = button("Back 5s", () => onSeek(-5));
    const forward = button("Forward 5s", () => onSeek(5));
    bar.append(play, pause, back, forward);
    return bar;
  }

  function button(label, action) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", action);
    return node;
  }

  function attachAudio(url) {
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.playsInline = true;
    audio.volume = 1;
    audio.muted = false;
    audio.src = url;
    return audio;
  }

  function crank(audio) {
    if (!audio) return;
    audio.muted = false;
    audio.volume = 1;
  }

  function mountStoryboardPlayer(ctx, mode) {
    const status = document.createElement("p");
    status.className = "alt-status";
    status.textContent = "Fetching storyboards and audio…";
    ctx.extras.append(status);

    return fetchStreams(ctx.videoId).then(async (streams) => {
      if (cancelled(ctx)) return;
      if (!streams.preview) {
        throw new Error("No storyboard for this video.");
      }
      if (!streams.audioUrl) throw new Error("No audio stream was returned for this video.");

      const sheets = new Map();
      const audio = attachAudio(streams.audioUrl);
      audio.hidden = true;
      const stop = { dead: false };
      const draw = { index: -1 };

      let surface;
      if (mode === "img") {
        const clip = document.createElement("div");
        clip.className = "sprite-clip";
        surface = document.createElement("img");
        surface.alt = "";
        clip.append(surface);
        ctx.stage.append(clip);
      } else {
        surface = document.createElement("canvas");
        surface.className = "alt-surface";
        surface.width = streams.preview.frameWidth * 2;
        surface.height = streams.preview.frameHeight * 2;
        ctx.stage.append(surface);
      }
      ctx.stage.append(audio);

      const canvasCtx = mode === "canvas" ? surface.getContext("2d", { alpha: false }) : null;

      const perPage = streams.preview.framesPerPageX * streams.preview.framesPerPageY;

      function ensureSheet(page) {
        if (sheets.has(page) || page < 0 || page >= streams.preview.urls.length) return;
        sheets.set(page, null);
        loadImage(streams.preview.urls[page]).then((image) => {
          if (stop.dead) return;
          sheets.set(page, image);
          draw.index = -1;
          sync();
        }).catch(() => {});
      }

      function paint(frameIndex) {
        const max = Math.max(0, (streams.preview.totalCount || 1) - 1);
        const safe = Math.max(0, Math.min(max, frameIndex));
        const page = Math.floor(safe / perPage);
        const sheet = sheets.get(page);
        ensureSheet(page);
        ensureSheet(page + 1);
        if (!sheet || safe === draw.index) return;
        draw.index = safe;
        const local = safe % perPage;
        const col = local % streams.preview.framesPerPageX;
        const row = Math.floor(local / streams.preview.framesPerPageX);
        if (mode === "canvas") {
          canvasCtx.drawImage(
            sheet,
            col * streams.preview.frameWidth,
            row * streams.preview.frameHeight,
            streams.preview.frameWidth,
            streams.preview.frameHeight,
            0,
            0,
            surface.width,
            surface.height
          );
        } else {
          surface.src = streams.preview.urls[page];
          surface.style.width = (streams.preview.framesPerPageX * 100) + "%";
          surface.style.height = (streams.preview.framesPerPageY * 100) + "%";
          surface.style.left = (-col * 100) + "%";
          surface.style.top = (-row * 100) + "%";
        }
      }

      function sync() {
        if (stop.dead) return;
        const ms = (audio.currentTime || 0) * 1000;
        paint(Math.floor(ms / streams.preview.durationPerFrame));
        if (!audio.paused && !audio.ended) root.requestAnimationFrame(sync);
      }

      paint(0);
      const every = Math.round(streams.preview.durationPerFrame / 100) / 10;
      ctx.extras.append(createTransport(
        () => { crank(audio); audio.play().then(sync).catch(() => { status.textContent = "Press Play. Autoplay was blocked."; }); },
        () => audio.pause(),
        (delta) => {
          audio.currentTime = Math.max(0, (audio.currentTime || 0) + delta);
          sync();
        }
      ));

      audio.addEventListener("play", sync);
      audio.addEventListener("seeked", sync);
      audio.addEventListener("error", () => {
        status.textContent = "Audio element failed. This screen may also be blocking HTMLMediaElement audio.";
      });

      status.textContent = (mode === "img" ? "Image sprite" : "Storyboard canvas")
        + " + audio at 100%. One preview frame about every " + every + "s. No <video>.";

      crank(audio);
      const playAttempt = audio.play();
      if (playAttempt) playAttempt.then(sync).catch(() => {
        status.textContent += " Press Play for sound.";
      });

      ctx.bind({
        destroy() {
          stop.dead = true;
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        },
      });
    });
  }

  function mountWebCodecsPlayer(ctx) {
    const status = document.createElement("p");
    status.className = "alt-status";
    status.textContent = "Fetching an MP4 and starting WebCodecs…";
    ctx.extras.append(status);

    if (typeof root.VideoDecoder !== "function") {
      return Promise.reject(new Error("This browser has no WebCodecs VideoDecoder."));
    }

    return Promise.all([fetchStreams(ctx.videoId), loadMp4Box()]).then(async ([streams, MP4Box]) => {
      const url = streams.progressiveUrl || streams.videoOnlyUrl;
      if (!url) throw new Error("No MP4 stream was returned for WebCodecs.");

      const canvas = document.createElement("canvas");
      canvas.className = "alt-surface";
      canvas.width = 640;
      canvas.height = 360;
      const canvasCtx = canvas.getContext("2d", { alpha: false });
      ctx.stage.append(canvas);

      const audio = streams.audioUrl ? attachAudio(streams.audioUrl) : null;
      if (audio) {
        audio.hidden = true;
        ctx.stage.append(audio);
      }

      const state = {
        dead: false,
        frames: [],
        decoded: 0,
        samples: 0,
        decoder: null,
        trackId: null,
      };

      const file = MP4Box.createFile();
      let settleReady;
      const readyPromise = new Promise((resolve, reject) => { settleReady = { resolve, reject }; });

      file.onError = (error) => settleReady.reject(new Error(String(error)));
      file.onReady = (info) => {
        try {
          const track = info.videoTracks[0];
          if (!track) throw new Error("No video track in the MP4.");
          state.trackId = track.id;
          canvas.width = track.track_width || 640;
          canvas.height = track.track_height || 360;

          const description = sampleDescription(file, track.id);
          const codec = track.codec || "avc1.42E01E";
          const decoder = new VideoDecoder({
            output(frame) {
              state.decoded += 1;
              if (state.dead) {
                frame.close();
                return;
              }
              // Keep a small queue and always retain the newest frame for the paint loop.
              state.frames.push(frame);
              while (state.frames.length > 24) state.frames.shift().close();
            },
            error(error) {
              status.textContent = "VideoDecoder error: " + error.message;
            },
          });

          const config = {
            codec: codec,
            codedWidth: track.track_width,
            codedHeight: track.track_height,
            optimizeForLatency: true,
          };
          if (description) config.description = description;
          decoder.configure(config);
          state.decoder = decoder;
          file.setExtractionOptions(track.id, null, { nbSamples: 100 });
          settleReady.resolve({ codec: codec, hasDescription: Boolean(description), track: track });
        } catch (error) {
          settleReady.reject(error);
        }
      };

      file.onSamples = (id, user, samples) => {
        if (state.dead || !state.decoder || state.decoder.state === "closed") return;
        for (const sample of samples) {
          state.samples += 1;
          const chunk = new EncodedVideoChunk({
            type: sample.is_sync ? "key" : "delta",
            timestamp: Math.round((sample.cts * 1_000_000) / sample.timescale),
            duration: Math.round((sample.duration * 1_000_000) / sample.timescale),
            data: sample.data,
          });
          try { state.decoder.decode(chunk); } catch (error) { /* drop bad sample */ }
        }
      };

      if (cancelled(ctx)) return;
      status.textContent = "Downloading MP4…";
      const download = new AbortController();
      state.abort = () => download.abort();
      ctx.bind({
        destroy() {
          state.dead = true;
          try { download.abort(); } catch (error) { /* already aborted */ }
        },
      });
      let response;
      try {
        response = await fetch(url, { signal: download.signal });
      } catch (error) {
        if (state.dead || (error && error.name === "AbortError")) return;
        const message = "MP4 download was blocked (the stream host does not allow this page to fetch it). Try the next technique.";
        status.textContent = message;
        throw new Error(message);
      }
      if (!response.ok) {
        const message = "MP4 fetch failed (" + response.status + ").";
        status.textContent = message;
        throw new Error(message);
      }
      const buffer = await response.arrayBuffer();
      if (cancelled(ctx) || state.dead) return;
      buffer.fileStart = 0;
      file.appendBuffer(buffer);
      file.flush();
      const meta = await readyPromise;
      if (cancelled(ctx) || state.dead) return;
      file.start();

      let raf = 0;
      function paint() {
        if (state.dead) return;
        if (state.frames.length) {
          // Prefer audio clock when it is close; otherwise show the newest decoded frame.
          let chosen = null;
          if (audio && !audio.paused) {
            const clock = audio.currentTime * 1_000_000;
            while (state.frames.length > 1 && state.frames[1].timestamp <= clock) {
              state.frames.shift().close();
            }
            const head = state.frames[0];
            if (head && (head.timestamp <= clock + 250_000 || state.frames.length > 8)) {
              chosen = state.frames.shift();
            }
          }
          if (!chosen && state.frames.length) {
            chosen = state.frames.pop();
            while (state.frames.length) state.frames.shift().close();
          }
          if (chosen) {
            canvasCtx.drawImage(chosen, 0, 0, canvas.width, canvas.height);
            chosen.close();
          }
        }
        raf = root.requestAnimationFrame(paint);
      }

      ctx.extras.append(createTransport(
        () => { crank(audio); if (audio) audio.play().catch(() => {}); },
        () => { if (audio) audio.pause(); },
        (delta) => {
          if (!audio) return;
          audio.currentTime = Math.max(0, (audio.currentTime || 0) + delta);
        }
      ));

      status.textContent = "WebCodecs " + meta.codec + " → canvas"
        + (audio ? ", sound via <audio>." : ".")
        + " No <video>.";

      paint();
      if (audio) {
        crank(audio);
        audio.play().catch(() => {
          status.textContent += " Press Play for sound.";
        });
      }

      const watchdog = root.setTimeout(() => {
        if (!state.dead && state.decoded === 0) {
          status.textContent = "WebCodecs got " + state.samples + " samples but decoded 0 frames ("
            + meta.codec + ", description=" + meta.hasDescription + "). This stream may need another demux path.";
        }
      }, 4000);

      ctx.bind({
        destroy() {
          state.dead = true;
          try { if (state.abort) state.abort(); } catch (error) { /* already aborted */ }
          root.clearTimeout(watchdog);
          root.cancelAnimationFrame(raf);
          if (audio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
          }
          state.frames.forEach((frame) => frame.close());
          state.frames = [];
          if (state.decoder && state.decoder.state !== "closed") {
            try { state.decoder.close(); } catch (error) { /* already closed */ }
          }
        },
      });
    });
  }

  function sampleDescription(file, trackId) {
    const trak = file.getTrackById(trackId);
    const DataStreamRef = root.DataStream;
    if (!trak || !DataStreamRef) return undefined;
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;
      const stream = new DataStreamRef(undefined, 0, DataStreamRef.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
    return undefined;
  }

  root.AltPlayers = {
    mountStoryboardCanvas(ctx) { return mountStoryboardPlayer(ctx, "canvas"); },
    mountStoryboardImg(ctx) { return mountStoryboardPlayer(ctx, "img"); },
    mountWebCodecs(ctx) { return mountWebCodecsPlayer(ctx); },
  };
})(window);
