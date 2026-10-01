(function (root) {
  const PIPED_APIS = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.ducks.party",
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

  async function fetchStreams(videoId) {
    if (streamCache.has(videoId)) return streamCache.get(videoId);
    const errors = [];
    for (const base of PIPED_APIS) {
      try {
        const response = await fetch(base + "/streams/" + encodeURIComponent(videoId), {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          errors.push(base + " → " + response.status);
          continue;
        }
        const data = await response.json();
        const normalized = normalizeStreams(data, base);
        if (!normalized.audioUrl && !normalized.progressiveUrl) {
          errors.push(base + " → no playable streams");
          continue;
        }
        streamCache.set(videoId, normalized);
        return normalized;
      } catch (error) {
        errors.push(base + " → " + (error && error.message ? error.message : "failed"));
      }
    }
    throw new Error("No stream metadata. Tried: " + errors.join("; "));
  }

  function normalizeStreams(data) {
    const progressive = (data.videoStreams || [])
      .filter((stream) => !stream.videoOnly && /mp4/i.test(stream.mimeType || stream.format || ""))
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0];

    const audioOnly = (data.audioStreams || [])
      .slice()
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    const videoOnly = (data.videoStreams || [])
      .filter((stream) => stream.videoOnly && /mp4/i.test(stream.mimeType || ""))
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0];

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

  function pickPreview(list) {
    const normalized = list.map(normalizePreview).filter(Boolean);
    if (!normalized.length) return null;
    normalized.sort((a, b) => (b.frameWidth * b.frameHeight) - (a.frameWidth * a.frameHeight));
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
      image.crossOrigin = "anonymous";
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
    audio.crossOrigin = "anonymous";
    audio.src = url;
    audio.setAttribute("controlslist", "nodownload");
    return audio;
  }

  function mountStoryboardPlayer(ctx, mode) {
    const status = document.createElement("p");
    status.className = "alt-status";
    status.textContent = "Fetching storyboards and audio…";
    ctx.extras.append(status);

    return fetchStreams(ctx.videoId).then(async (streams) => {
      if (!streams.preview) {
        throw new Error("No storyboard for this video. Short clips often have none. Audio alone is not enough for this card.");
      }
      if (!streams.audioUrl) throw new Error("No audio stream was returned for this video.");

      const sheets = await loadPreviewSheets(streams.preview);
      const audio = attachAudio(streams.audioUrl);
      audio.hidden = true;
      const stop = { dead: false };
      const draw = { index: -1 };

      let surface;
      if (mode === "img") {
        surface = document.createElement("img");
        surface.className = "alt-surface";
        surface.alt = "Storyboard frame stream";
        ctx.stage.append(surface);
      } else {
        surface = document.createElement("canvas");
        surface.className = "alt-surface";
        surface.width = streams.preview.frameWidth * 2;
        surface.height = streams.preview.frameHeight * 2;
        ctx.stage.append(surface);
      }
      ctx.stage.append(audio);

      const scratch = document.createElement("canvas");
      scratch.width = streams.preview.frameWidth;
      scratch.height = streams.preview.frameHeight;
      const scratchCtx = scratch.getContext("2d", { alpha: false });
      const canvasCtx = mode === "canvas" ? surface.getContext("2d", { alpha: false }) : null;

      function paint(frameIndex) {
        const max = Math.max(0, (streams.preview.totalCount || 1) - 1);
        const safe = Math.max(0, Math.min(max, frameIndex));
        if (safe === draw.index) return;
        draw.index = safe;
        const source = frameSource(streams.preview, sheets, safe);
        scratchCtx.drawImage(
          source.sheet,
          source.sx,
          source.sy,
          source.sw,
          source.sh,
          0,
          0,
          scratch.width,
          scratch.height
        );
        if (mode === "canvas") {
          canvasCtx.drawImage(scratch, 0, 0, surface.width, surface.height);
        } else {
          if (surface._blobUrl) URL.revokeObjectURL(surface._blobUrl);
          scratch.toBlob((blob) => {
            if (!blob || stop.dead) return;
            const url = URL.createObjectURL(blob);
            surface._blobUrl = url;
            surface.src = url;
          }, "image/jpeg", 0.85);
        }
      }

      function sync() {
        if (stop.dead) return;
        const ms = (audio.currentTime || 0) * 1000;
        paint(Math.floor(ms / streams.preview.durationPerFrame));
        if (!audio.paused && !audio.ended) root.requestAnimationFrame(sync);
      }

      paint(0);
      ctx.extras.append(createTransport(
        () => { audio.play().then(sync).catch(() => { status.textContent = "Tap Play again. The browser blocked autoplay."; }); },
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

      status.textContent = mode === "img"
        ? "Image-element frame stream + audio element. No <video>. Storyboard JPEGs, synced to the audio timeline."
        : "Storyboard scrub on canvas + audio element. No <video>. Preview frames from YouTube’s storyboard, sound from the progressive/audio stream.";

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
          if (surface._blobUrl) URL.revokeObjectURL(surface._blobUrl);
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

      status.textContent = "Downloading progressive MP4…";
      const response = await fetch(url);
      if (!response.ok) throw new Error("MP4 fetch failed (" + response.status + ").");
      const buffer = await response.arrayBuffer();
      buffer.fileStart = 0;
      const info = (() => {
        file.appendBuffer(buffer);
        file.flush();
        return readyPromise;
      })();
      const meta = await info;
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
        () => { if (audio) audio.play().catch(() => {}); },
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
