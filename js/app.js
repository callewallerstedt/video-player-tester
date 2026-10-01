(function () {
  const ALLOW = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";

  const params = new URLSearchParams(location.search);
  const isRemote = params.get("role") === "remote";
  let room = params.get("room");
  let videoId = "";
  let linkStartSeconds = 0;
  let activeCategory = "All";
  let relay;

  if (!isRemote) {
    if (!room) room = sessionStorage.getItem("vpt-room") || createRoom();
    sessionStorage.setItem("vpt-room", room);
    const url = new URL(location.href);
    url.searchParams.set("room", room);
    url.searchParams.delete("role");
    history.replaceState(null, "", url);
  }

  const METHODS = buildMethods();

  function createRoom() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  }

  function topic() {
    return "vpt-" + room;
  }

  function remoteUrl() {
    const url = new URL(location.href);
    url.searchParams.set("room", room);
    url.searchParams.set("role", "remote");
    url.searchParams.delete("v");
    url.hash = "";
    return url.toString();
  }

  function parseYouTubeId(input) {
    if (!input) return null;
    const text = String(input).trim();
    if (/^[\w-]{11}$/.test(text)) return text;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : "https://" + text);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const asId = (value) => (value && /^[\w-]{11}$/.test(value) ? value : null);
    if (host === "youtu.be") return asId(url.pathname.split("/").filter(Boolean)[0]);
    const known = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host);
    if (!known) return null;
    const fromQuery = asId(url.searchParams.get("v"));
    if (fromQuery) return fromQuery;
    const parts = url.pathname.split("/").filter(Boolean);
    const keyAt = parts.findIndex((part) => ["embed", "shorts", "live", "v", "e"].includes(part));
    if (keyAt >= 0) return asId(parts[keyAt + 1]);
    return null;
  }

  function parseStartSeconds(input) {
    try {
      const text = String(input).trim();
      const url = new URL(/^https?:\/\//i.test(text) ? text : "https://" + text);
      const raw = url.searchParams.get("t") || url.searchParams.get("start") || "";
      if (raw) return decodeTime(raw);
      const hashed = new URLSearchParams(url.hash.replace(/^#/, "")).get("t") || "";
      return hashed ? decodeTime(hashed) : 0;
    } catch {
      return 0;
    }
  }

  function decodeTime(raw) {
    if (/^\d+$/.test(raw)) return Number(raw);
    const match = String(raw).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match || match[0] === "") return 0;
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }

  function youtubeEmbed(id, query, host) {
    const url = new URL("https://" + (host || "www.youtube.com") + "/embed/" + id);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });
    return url.toString();
  }

  function makeFrame(src, label, options) {
    const opts = options || {};
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.title = label;
    frame.allow = ALLOW;
    frame.referrerPolicy = opts.referrerPolicy || "strict-origin-when-cross-origin";
    frame.loading = "lazy";
    frame.className = opts.className || "cover-media";
    if (opts.allowFullscreen !== false) frame.allowFullscreen = true;
    if (opts.sandbox) frame.setAttribute("sandbox", opts.sandbox);
    if (opts.credentialless) frame.setAttribute("credentialless", "");
    return frame;
  }

  function embedMethod(spec) {
    return {
      ratio: spec.ratio || "16 / 9",
      clip: spec.clip || "",
      category: spec.category,
      id: spec.id,
      title: spec.title,
      note: spec.note,
      technique: spec.technique,
      mount(ctx) {
        const query = typeof spec.params === "function" ? spec.params(ctx) : (spec.params || {});
        const src = spec.src ? spec.src(ctx) : youtubeEmbed(ctx.videoId, query, spec.host);
        ctx.stage.append(makeFrame(src, spec.title, spec.frame || {}));
        if (spec.overlay) {
          const overlay = document.createElement("div");
          overlay.className = spec.overlay;
          ctx.stage.append(overlay);
        }
        if (spec.afterMount) spec.afterMount(ctx);
      },
    };
  }

  function buildMethods() {
    const embedDoc = "Embed document";
    const paramsCat = "Player parameters";
    const outside = "Outside the player";

    return [
      {
        id: "storyboard-scrub",
        category: outside,
        title: "Storyboard scrub + audio",
        note: "YouTube’s storyboard sprite sheets painted on a canvas, timed to a real audio stream. No <video> and no YouTube iframe. Sound uses an <audio> element.",
        technique: "canvas + storyboard + <audio>",
        mount: (ctx) => window.AltPlayers.mountStoryboardCanvas(ctx),
      },
      {
        id: "img-frame-stream",
        category: outside,
        title: "Image frame stream + audio",
        note: "MJPEG-style playback through an <img> element. Each storyboard cell becomes a JPEG blob URL. Sound uses the same audio stream. No <video>.",
        technique: "<img> JPEG blobs + <audio>",
        mount: (ctx) => window.AltPlayers.mountStoryboardImg(ctx),
      },
      {
        id: "webcodecs-canvas",
        category: outside,
        title: "WebCodecs → canvas + audio",
        note: "Fetches a progressive MP4, demuxes it, and decodes frames with VideoDecoder onto a canvas. Sound rides an <audio> element from the same file. No <video>.",
        technique: "VideoDecoder + canvas + <audio>",
        mount: (ctx) => window.AltPlayers.mountWebCodecs(ctx),
      },
      embedMethod({
        id: "standard-iframe",
        category: embedDoc,
        title: "Standard iframe embed",
        note: "A normal browsing context. This is the official YouTube embed URL with the control bar left on.",
        technique: "<iframe src=\"youtube.com/embed\">",
      }),
      embedMethod({
        id: "nocookie",
        category: embedDoc,
        title: "Privacy-enhanced iframe",
        note: "Same player, loaded from youtube-nocookie.com so the embed waits longer before setting cookies.",
        technique: "youtube-nocookie.com/embed",
        host: "www.youtube-nocookie.com",
      }),
      {
        id: "object-element",
        category: embedDoc,
        title: "Object element",
        note: "An old replaced element. The embed URL is the object’s data, with type text/html, instead of an iframe.",
        technique: "<object data=\"…/embed\">",
        mount(ctx) {
          const node = document.createElement("object");
          node.data = youtubeEmbed(ctx.videoId);
          node.type = "text/html";
          node.className = "cover-media";
          node.setAttribute("aria-label", "Object element");
          ctx.stage.append(node);
        },
      },
      {
        id: "embed-element",
        category: embedDoc,
        title: "Embed element",
        note: "The legacy embed tag. Browsers still treat type text/html as a nested document.",
        technique: "<embed src=\"…/embed\">",
        mount(ctx) {
          const node = document.createElement("embed");
          node.src = youtubeEmbed(ctx.videoId);
          node.type = "text/html";
          node.className = "cover-media";
          node.setAttribute("aria-label", "Embed element");
          ctx.stage.append(node);
        },
      },
      {
        id: "srcdoc-nested",
        category: embedDoc,
        title: "Nested srcdoc frame",
        note: "An iframe whose document is written in srcdoc, and that document holds the YouTube iframe. Two browsing contexts.",
        technique: "<iframe srcdoc>",
        mount(ctx) {
          const inner = youtubeEmbed(ctx.videoId);
          const doc = "<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head><body><iframe src=\"" + inner + "\" title=\"Nested YouTube embed\" allow=\"" + ALLOW + "\" allowfullscreen></iframe></body></html>";
          const outer = document.createElement("iframe");
          outer.srcdoc = doc;
          outer.title = "Nested srcdoc frame";
          outer.className = "fill-host";
          outer.setAttribute("scrolling", "no");
          ctx.stage.append(outer);
        },
      },
      {
        id: "shadow-dom",
        category: embedDoc,
        title: "Shadow DOM host",
        note: "The iframe lives in an open shadow root, so page CSS does not style it. The player itself is unchanged.",
        technique: "element.attachShadow()",
        mount(ctx) {
          const host = document.createElement("div");
          host.className = "fill-host";
          const shadow = host.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = ":host{display:block;width:100%;height:100%}iframe{width:100%;height:100%;border:0}";
          const frame = makeFrame(youtubeEmbed(ctx.videoId), "Shadow DOM host", { className: "" });
          frame.style.width = "100%";
          frame.style.height = "100%";
          shadow.append(style, frame);
          ctx.stage.append(host);
        },
      },
      {
        id: "foreign-object",
        category: embedDoc,
        title: "SVG foreignObject",
        note: "The iframe is painted inside an SVG foreignObject. Several browsers leave this blank on purpose.",
        technique: "<svg><foreignObject>",
        mount(ctx) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("viewBox", "0 0 160 90");
          svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
          const foreign = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
          foreign.setAttribute("x", "0");
          foreign.setAttribute("y", "0");
          foreign.setAttribute("width", "160");
          foreign.setAttribute("height", "90");
          const wrap = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
          wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
          wrap.style.cssText = "width:100%;height:100%;margin:0;background:#000;";
          const frame = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
          frame.src = youtubeEmbed(ctx.videoId);
          frame.title = "SVG foreignObject";
          frame.setAttribute("allow", ALLOW);
          frame.setAttribute("allowfullscreen", "true");
          frame.style.cssText = "width:100%;height:100%;border:0;";
          wrap.append(frame);
          foreign.append(wrap);
          svg.append(foreign);
          ctx.stage.append(svg);
        },
      },
      embedMethod({
        id: "sandboxed",
        category: embedDoc,
        title: "Sandboxed iframe",
        note: "A sandbox attribute limits the nested document. YouTube often refuses to play inside one.",
        technique: "iframe sandbox",
        frame: { sandbox: SANDBOX },
      }),
      embedMethod({
        id: "credentialless",
        category: embedDoc,
        title: "Credentialless iframe",
        note: "The credentialless attribute loads the embed without cookies. Chromium supports it. YouTube may block the result.",
        technique: "iframe credentialless",
        frame: { credentialless: true },
      }),
      embedMethod({
        id: "no-referrer",
        category: embedDoc,
        title: "No-referrer iframe",
        note: "referrerpolicy is no-referrer, so YouTube does not see which page embedded it. Some videos then refuse to play.",
        technique: "referrerpolicy=\"no-referrer\"",
        frame: { referrerPolicy: "no-referrer" },
      }),
      embedMethod({
        id: "legacy-v",
        category: embedDoc,
        title: "Legacy /v/ path",
        note: "The Flash-era /v/ URL. It is usually a dead document now, which is itself a useful result.",
        technique: "youtube.com/v",
        src: (ctx) => "https://www.youtube.com/v/" + ctx.videoId + "?version=3",
      }),
      embedMethod({
        id: "chromeless",
        category: paramsCat,
        title: "Chromeless",
        note: "controls=0 hides the control bar. Muted autoplay is on so the picture still moves.",
        technique: "controls=0&autoplay=1&mute=1",
        params: { controls: "0", autoplay: "1", mute: "1" },
      }),
      embedMethod({
        id: "muted-autoplay",
        category: paramsCat,
        title: "Muted autoplay",
        note: "autoplay=1 and mute=1. The control bar stays, and browsers allow this because the sound is off.",
        technique: "autoplay=1&mute=1",
        params: { autoplay: "1", mute: "1" },
      }),
      embedMethod({
        id: "loop",
        category: paramsCat,
        title: "Loop",
        note: "loop=1 only repeats a single video when playlist is that same video id. Press play and let it reach the end.",
        technique: "loop=1&playlist={id}",
        params: (ctx) => ({ loop: "1", playlist: ctx.videoId }),
      }),
      embedMethod({
        id: "kiosk",
        category: paramsCat,
        title: "Kiosk embed",
        note: "The signage combination: muted autoplay, no controls, and a loop. There is no control bar to pause it.",
        technique: "autoplay+mute+controls=0+loop",
        params: (ctx) => ({ autoplay: "1", mute: "1", controls: "0", loop: "1", playlist: ctx.videoId }),
      }),
      embedMethod({
        id: "captions",
        category: paramsCat,
        title: "Forced captions",
        note: "cc_load_policy=1 asks for captions immediately. If this video has none, the picture looks like the standard embed.",
        technique: "cc_load_policy=1",
        params: { cc_load_policy: "1", cc_lang_pref: "en" },
      }),
      embedMethod({
        id: "start-offset",
        category: paramsCat,
        title: "Start offset",
        note: "start=30 opens the timeline at 0:30. A shorter video lands near its end.",
        technique: "start=30",
        params: { start: "30" },
      }),
      embedMethod({
        id: "hard-out",
        category: paramsCat,
        title: "Hard out",
        note: "end=15 stops the embed fifteen seconds in. Press play and wait for the stop.",
        technique: "end=15",
        params: { end: "15" },
      }),
      embedMethod({
        id: "clip-window",
        category: paramsCat,
        title: "Clip window",
        note: "start and end together play only 0:10 through 0:25.",
        technique: "start=10&end=25",
        params: { start: "10", end: "25" },
      }),
      embedMethod({
        id: "honor-timestamp",
        category: paramsCat,
        title: "Link timestamp",
        note: "Uses the t= or start= value from the link you pasted. With no timestamp, it starts at 0:00.",
        technique: "start={t from the link}",
        params: () => ({ start: String(linkStartSeconds || 0) }),
        afterMount(ctx) {
          ctx.extras.textContent = linkStartSeconds
            ? "Starting at " + linkStartSeconds + "s from the pasted link."
            : "That link had no t= or start= value.";
        },
      }),
      embedMethod({
        id: "youtube-mix",
        category: paramsCat,
        title: "YouTube Mix",
        note: "listType=playlist and a list id of RD plus the video id. This is YouTube’s radio, not a single-video embed.",
        technique: "list=RD{id}",
        params: (ctx) => ({ listType: "playlist", list: "RD" + ctx.videoId }),
      }),
      embedMethod({
        id: "modest",
        category: paramsCat,
        title: "Modest branding",
        note: "modestbranding=1 and rel=0. YouTube has retired parts of this, so compare the chrome with the standard card.",
        technique: "modestbranding=1&rel=0",
        params: { modestbranding: "1", rel: "0" },
      }),
      embedMethod({
        id: "fullscreen-blocked",
        category: paramsCat,
        title: "Fullscreen blocked",
        note: "fs=0 hides the fullscreen control, and this iframe also omits allowfullscreen. That second part is the Permissions Policy.",
        technique: "fs=0, no allowfullscreen",
        params: { fs: "0" },
        frame: { allowFullscreen: false },
      }),
      embedMethod({
        id: "keyboard-ignored",
        category: paramsCat,
        title: "Keyboard ignored",
        note: "disablekb=1 turns off the player’s keyboard shortcuts. Click the video, then try the space bar or arrow keys.",
        technique: "disablekb=1",
        params: { disablekb: "1" },
      }),
      embedMethod({
        id: "white-progress",
        category: paramsCat,
        title: "White progress bar",
        note: "color=white paints the progress bar white instead of red. Play it and look at the bar.",
        technique: "color=white",
        params: { color: "white" },
      }),
      embedMethod({
        id: "japanese-ui",
        category: paramsCat,
        title: "Japanese player UI",
        note: "hl=ja sets the player chrome language. The spoken audio does not change.",
        technique: "hl=ja",
        params: { hl: "ja" },
      }),
      embedMethod({
        id: "legacy-theme",
        category: paramsCat,
        title: "Legacy dark theme",
        note: "theme=dark is an old parameter. YouTube may ignore it. The card is here so you can see if anything still changes.",
        technique: "theme=dark",
        params: { theme: "dark" },
      }),
      embedMethod({
        id: "annotations-off",
        category: paramsCat,
        title: "Annotations off",
        note: "iv_load_policy=3 hides annotations. Most videos no longer have any, so this often matches the standard embed.",
        technique: "iv_load_policy=3",
        params: { iv_load_policy: "3" },
      }),
      embedMethod({
        id: "playsinline",
        category: paramsCat,
        title: "Playsinline",
        note: "playsinline=1 asks mobile browsers to play inside the page instead of forcing a system fullscreen.",
        technique: "playsinline=1",
        params: { playsinline: "1" },
      }),
      {
        id: "video-wall",
        category: "Composition",
        title: "Video wall",
        note: "Four independent embeds of the same video in a 2×2 grid. They do not share a clock, and this card is heavy.",
        technique: "2×2 iframe grid",
        mount(ctx) {
          const wall = document.createElement("div");
          wall.className = "wall";
          for (let index = 0; index < 4; index += 1) {
            const cell = document.createElement("div");
            cell.className = "wall-cell";
            cell.append(makeFrame(youtubeEmbed(ctx.videoId), "Video wall " + (index + 1), { className: "" }));
            wall.append(cell);
          }
          ctx.stage.append(wall);
        },
      },
      {
        id: "split-frame",
        category: "Composition",
        title: "Split frame",
        note: "Two copies of the embed, each 200% wide, clipped to a half. The left pane shows the left half and the right pane shows the right half.",
        technique: "overflow clip + negative offset",
        mount(ctx) {
          const split = document.createElement("div");
          split.className = "split";
          ["left", "right"].forEach((side) => {
            const pane = document.createElement("div");
            pane.className = "split-pane " + side;
            pane.append(makeFrame(youtubeEmbed(ctx.videoId), "Split frame " + side, { className: "" }));
            split.append(pane);
          });
          ctx.stage.append(split);
        },
      },
      embedMethod({
        id: "cinema-matte",
        category: "Composition",
        title: "Cinema matte",
        note: "The iframe is shorter than the stage and centered. The black bars are the stage, a matte, not a crop of the picture.",
        technique: "letterbox matte",
        frame: { className: "matte-frame" },
      }),
      {
        id: "inset-layout",
        category: "Composition",
        title: "Inset layout",
        note: "A large embed with a second embed floating over a corner. This is a picture-in-picture layout in CSS, not the Picture-in-Picture API.",
        technique: "stacked iframes",
        mount(ctx) {
          const back = makeFrame(youtubeEmbed(ctx.videoId), "Inset background", { className: "inset-back" });
          const pip = makeFrame(youtubeEmbed(ctx.videoId), "Inset corner", { className: "inset-pip" });
          ctx.stage.append(back, pip);
        },
      },
      {
        id: "linked-pair",
        category: "Composition",
        title: "Linked pair",
        note: "Two IFrame Player API players and one transport bar. Play, pause, and seek call both. They are not sample-accurate. The right one is grayscale.",
        technique: "YT.Player × 2, one transport",
        mount: mountLinkedPair,
      },
      apiMethod({
        id: "transport-bar",
        title: "Custom transport bar",
        note: "The IFrame Player API builds the player. Our buttons call playVideo, pauseVideo, seekTo, and mute. Those controls are ours, not YouTube’s bar.",
        technique: "YT.Player + transport bar",
        onReady(player, ctx) {
          addTransport(ctx, player);
        },
      }),
      apiMethod({
        id: "half-speed",
        title: "Half speed",
        note: "setPlaybackRate(0.5), then playVideo(). If 0.5× is unavailable, the card says which rates YouTube offered.",
        technique: "setPlaybackRate(0.5)",
        rate: 0.5,
      }),
      apiMethod({
        id: "time-and-a-half",
        title: "One and a half speed",
        note: "setPlaybackRate(1.5). Pitch shifts with the rate because this is the player’s playback rate, not a separate audio effect.",
        technique: "setPlaybackRate(1.5)",
        rate: 1.5,
      }),
      apiMethod({
        id: "double-speed",
        title: "Double speed",
        note: "setPlaybackRate(2). YouTube sometimes resets the rate when playback starts, so it is applied again on the playing state.",
        technique: "setPlaybackRate(2)",
        rate: 2,
      }),
      apiMethod({
        id: "quiet",
        title: "Quiet volume",
        note: "setVolume(12) and unMute(), then play. The YouTube bar can still change it afterward.",
        technique: "setVolume(12)",
        onReady(player, ctx) {
          player.setVolume(12);
          player.unMute();
          player.playVideo();
          ctx.extras.textContent = "Volume set to 12 with setVolume.";
        },
      }),
      apiMethod({
        id: "cued",
        title: "Cued until play",
        note: "cueVideoById loads the poster and the metadata, and waits. Nothing plays until you press the button on this card.",
        technique: "cueVideoById()",
        cue: true,
        onReady(player, ctx) {
          player.cueVideoById(ctx.videoId);
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Play cued video";
          button.addEventListener("click", () => player.playVideo());
          ctx.extras.append(button);
        },
      }),
    ];
  }

  function apiMethod(spec) {
    return {
      id: spec.id,
      category: "Script API",
      title: spec.title,
      note: spec.note,
      technique: spec.technique,
      ratio: "16 / 9",
      mount(ctx) {
        return mountApiPlayer(ctx, {
          cue: spec.cue,
          onReady(player) {
            if (spec.rate) applyRate(player, spec.rate, ctx);
            if (spec.onReady) spec.onReady(player, ctx);
          },
          onState(event) {
            if (spec.rate && event.data === window.YT.PlayerState.PLAYING) {
              event.target.setPlaybackRate(spec.rate);
            }
          },
        });
      },
    };
  }

  let ytReady;

  function loadApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("IFrame Player API did not load.")), 15000);
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("IFrame Player API script was blocked."));
      };
      document.head.append(script);
    });
    return ytReady;
  }

  function mountApiPlayer(ctx, setup) {
    const slot = document.createElement("div");
    slot.className = "yt-slot";
    ctx.stage.append(slot);
    return loadApi().then(() => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Player API timed out.")), 20000);
      const config = {
        width: "100%",
        height: "100%",
        playerVars: {
          origin: location.origin,
          rel: "0",
          enablejsapi: "1",
        },
        events: {
          onReady(event) {
            clearTimeout(timeout);
            ctx.bind(event.target);
            setup.onReady(event.target);
            resolve();
          },
          onStateChange(event) {
            if (setup.onState) setup.onState(event);
          },
          onError() {
            clearTimeout(timeout);
            ctx.extras.textContent = "YouTube refused this player. The video may block embedding.";
            resolve();
          },
        },
      };
      if (!setup.cue) config.videoId = ctx.videoId;
      const player = new window.YT.Player(slot, config);
      ctx.bind(player);
    }));
  }

  function applyRate(player, want, ctx) {
    const rates = player.getAvailablePlaybackRates();
    const rate = rates.indexOf(want) >= 0 ? want : (rates.indexOf(1) >= 0 ? 1 : rates[0]);
    player.setPlaybackRate(rate);
    player.playVideo();
    ctx.extras.textContent = rate === want
      ? "Playing at " + rate + "× via setPlaybackRate."
      : want + "× is not offered. Playing at " + rate + "×. Offered: " + rates.join(", ") + ".";
  }

  function addTransport(ctx, player) {
    const bar = document.createElement("div");
    bar.className = "transport";
    const actions = [
      ["Play", () => player.playVideo()],
      ["Pause", () => player.pauseVideo()],
      ["Back 10s", () => player.seekTo(Math.max(0, player.getCurrentTime() - 10), true)],
      ["Forward 10s", () => player.seekTo((player.getCurrentTime() || 0) + 10, true)],
    ];
    actions.forEach(([label, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", action);
      bar.append(button);
    });
    const mute = document.createElement("button");
    mute.type = "button";
    mute.textContent = "Mute";
    mute.addEventListener("click", () => {
      if (player.isMuted()) {
        player.unMute();
        mute.textContent = "Mute";
      } else {
        player.mute();
        mute.textContent = "Unmute";
      }
    });
    bar.append(mute);
    ctx.extras.append(bar);
  }

  function mountLinkedPair(ctx) {
    const split = document.createElement("div");
    split.className = "pair";
    const leftPane = document.createElement("div");
    leftPane.className = "pair-pane";
    const rightPane = document.createElement("div");
    rightPane.className = "pair-pane dim";
    const leftSlot = document.createElement("div");
    const rightSlot = document.createElement("div");
    leftSlot.className = "yt-slot";
    rightSlot.className = "yt-slot";
    leftPane.append(leftSlot);
    rightPane.append(rightSlot);
    split.append(leftPane, rightPane);
    ctx.stage.append(split);

    return loadApi().then(() => new Promise((resolve, reject) => {
      const players = [];
      let ready = 0;
      const timeout = setTimeout(() => reject(new Error("Linked pair timed out.")), 20000);
      function make(slot) {
        const player = new window.YT.Player(slot, {
          width: "100%",
          height: "100%",
          videoId: ctx.videoId,
          playerVars: { origin: location.origin, rel: "0", enablejsapi: "1" },
          events: {
            onReady(event) {
              players.push(event.target);
              ready += 1;
              if (ready === 2) {
                clearTimeout(timeout);
                ctx.bind({
                  destroy() {
                    players.forEach((item) => {
                      try { item.destroy(); } catch (error) { /* already gone */ }
                    });
                  },
                });
                addPairTransport(ctx, players);
                resolve();
              }
            },
          },
        });
        return player;
      }
      make(leftSlot);
      make(rightSlot);
    }));
  }

  function addPairTransport(ctx, players) {
    const bar = document.createElement("div");
    bar.className = "transport";
    const actions = [
      ["Play both", () => players.forEach((player) => player.playVideo())],
      ["Pause both", () => players.forEach((player) => player.pauseVideo())],
      ["Restart both", () => players.forEach((player) => player.seekTo(0, true))],
    ];
    actions.forEach(([label, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", action);
      bar.append(button);
    });
    ctx.extras.append(bar);
  }

  function drawQr(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    document.getElementById("qr").src = qr.createDataURL(6);
  }

  function initRemote() {
    document.title = "Remote · Video Player Tester";
    const roomNode = document.getElementById("remote-room");
    const form = document.getElementById("remote-form");
    const input = document.getElementById("remote-url");
    const message = document.getElementById("remote-msg");
    const send = document.getElementById("remote-send");
    if (!room) {
      roomNode.textContent = "missing";
      message.textContent = "This remote link has no session. Scan the QR code on the tester screen.";
      message.classList.add("is-error");
      send.disabled = true;
      return;
    }
    roomNode.textContent = room;

    document.getElementById("remote-paste").addEventListener("click", async () => {
      try {
        input.value = await navigator.clipboard.readText();
        input.focus();
        setMessage(message, "", false);
      } catch {
        setMessage(message, "The browser blocked clipboard read. Long-press the field and paste.", true);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const raw = input.value;
      if (!parseYouTubeId(raw)) {
        setMessage(message, "Use a YouTube watch link, a youtu.be link, a Shorts link, or an 11-character video id.", true);
        return;
      }
      send.disabled = true;
      send.textContent = "Sending…";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch("https://ntfy.sh/" + topic(), {
          method: "POST",
          body: raw.trim(),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Relay rejected the link.");
        setMessage(message, "Sent. The comparison grid on the other screen should update. You can send another link.", false);
      } catch {
        setMessage(message, "The relay did not take the link. Paste it on the tester screen instead.", true);
      } finally {
        clearTimeout(timer);
        send.disabled = false;
        send.textContent = "Send to the screen";
      }
    });
  }

  function initDesk() {
    const grid = document.getElementById("grid");
    const cards = METHODS.map((method, index) => {
      const card = renderCard(method, index);
      grid.append(card);
      showIdle(card);
      return card;
    });

    drawQr(remoteUrl());
    document.getElementById("room-code").textContent = room;
    const anchor = document.getElementById("remote-anchor");
    anchor.href = remoteUrl();
    buildChips();
    applyFilter();
    connectRelay();

    document.getElementById("copy-link").addEventListener("click", async () => {
      const button = document.getElementById("copy-link");
      try {
        await navigator.clipboard.writeText(remoteUrl());
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy remote link"; }, 1600);
      } catch {
        button.textContent = "Copy failed";
      }
    });

    document.getElementById("new-session").addEventListener("click", () => {
      room = createRoom();
      sessionStorage.setItem("vpt-room", room);
      const url = new URL(location.href);
      url.searchParams.set("room", room);
      history.replaceState(null, "", url);
      document.getElementById("room-code").textContent = room;
      anchor.href = remoteUrl();
      drawQr(remoteUrl());
      connectRelay();
    });

    document.getElementById("desk-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = document.getElementById("desk-url").value;
      if (!acceptLink(raw, "screen")) {
        setMessage(document.getElementById("desk-msg"), "Use a YouTube watch link, a youtu.be link, a Shorts link, or an 11-character video id.", true);
      } else {
        setMessage(document.getElementById("desk-msg"), "", false);
      }
    });

    document.getElementById("filter-text").addEventListener("input", applyFilter);
    document.getElementById("mount-all").addEventListener("click", () => {
      cards.forEach((card) => {
        if (!card.classList.contains("is-out")) mountCard(card);
      });
    });
    document.getElementById("clear-video").addEventListener("click", () => {
      videoId = "";
      linkStartSeconds = 0;
      sessionStorage.removeItem("vpt-video");
      const url = new URL(location.href);
      url.searchParams.delete("v");
      history.replaceState(null, "", url);
      document.getElementById("bench-title").textContent = "Waiting for a video";
      document.getElementById("bench-sub").textContent = "Each card is one way to frame the same YouTube embed. A player lazy-mounts when its card intersects the screen.";
      document.getElementById("now-thumb").hidden = true;
      document.getElementById("live-status").textContent = "Waiting for a link";
      document.getElementById("live-status").classList.remove("is-on");
      document.getElementById("mount-all").disabled = true;
      document.getElementById("clear-video").disabled = true;
      cards.forEach((card) => {
        observer.unobserve(card);
        destroyPlayer(card);
        showIdle(card);
      });
    });

    const initialRaw = params.get("v") || sessionStorage.getItem("vpt-video") || "";
    if (initialRaw && parseYouTubeId(initialRaw)) acceptLink(initialRaw, "saved");

    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  function renderCard(method, index) {
    const card = document.createElement("article");
    card.className = "card";
    card.id = method.id;
    card.dataset.cat = method.category;
    card.dataset.index = String(index);
    card.dataset.search = [method.category, method.title, method.note, method.technique, method.id].join(" ").toLowerCase();

    const copy = document.createElement("div");
    copy.className = "card-copy";
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(index + 1).padStart(2, "0");
    eyebrow.append(num, document.createTextNode(" " + method.category));
    const heading = document.createElement("h3");
    const link = document.createElement("a");
    link.href = "#" + method.id;
    link.textContent = method.title;
    heading.append(link);
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = method.note;
    copy.append(eyebrow, heading, note);

    const stage = document.createElement("div");
    stage.className = "stage";
    const extras = document.createElement("div");
    extras.className = "extras";
    const foot = document.createElement("footer");
    foot.className = "card-foot";
    const code = document.createElement("code");
    code.textContent = method.technique;
    const state = document.createElement("span");
    state.className = "mount-state";
    state.textContent = "Idle";
    foot.append(code, state);
    card.append(copy, stage, extras, foot);
    return card;
  }

  function methodOf(card) {
    return METHODS[Number(card.dataset.index)];
  }

  function prepareStage(card) {
    const method = methodOf(card);
    const stage = card.querySelector(".stage");
    stage.className = "stage";
    stage.style.aspectRatio = method.ratio || "16 / 9";
    stage.style.clipPath = method.clip || "";
  }

  function showIdle(card) {
    prepareStage(card);
    const stage = card.querySelector(".stage");
    stage.replaceChildren();
    const idle = document.createElement("p");
    idle.className = "idle";
    idle.textContent = "Mounts when a link arrives";
    stage.append(idle);
    card.querySelector(".extras").replaceChildren();
    card.dataset.mounted = "0";
    card.querySelector(".mount-state").textContent = "Idle";
  }

  function showPoster(card) {
    prepareStage(card);
    const stage = card.querySelector(".stage");
    stage.replaceChildren();
    const image = document.createElement("img");
    image.className = "poster";
    image.alt = "";
    image.src = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mount-overlay";
    button.textContent = "Mount player";
    button.addEventListener("click", () => mountCard(card));
    stage.append(image, button);
    card.querySelector(".extras").replaceChildren();
    card.dataset.mounted = "0";
    card.querySelector(".mount-state").textContent = "Poster";
  }

  function destroyPlayer(card) {
    const player = card._player;
    card._player = null;
    if (player && typeof player.destroy === "function") {
      try { player.destroy(); } catch (error) { /* already gone */ }
    }
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) mountCard(entry.target);
    });
  }, { rootMargin: "120px 0px", threshold: 0.2 });

  function mountCard(card) {
    if (!videoId) return;
    if (card.dataset.mounted === "1" || card.dataset.mounted === "pending") return;
    card.dataset.mounted = "pending";
    card.querySelector(".mount-state").textContent = "Mounting";
    destroyPlayer(card);
    prepareStage(card);
    const stage = card.querySelector(".stage");
    const extras = card.querySelector(".extras");
    stage.replaceChildren();
    extras.replaceChildren();
    const method = methodOf(card);
    const ctx = {
      videoId: videoId,
      stage: stage,
      extras: extras,
      bind(player) { card._player = player; },
    };
    let pending;
    try {
      pending = method.mount(ctx);
    } catch (error) {
      failMount(card, error);
      return;
    }
    Promise.resolve(pending).then(() => {
      card.dataset.mounted = "1";
      card.querySelector(".mount-state").textContent = "Mounted";
      try { observer.unobserve(card); } catch (error) { /* observer not ready */ }
    }).catch((error) => failMount(card, error));
  }

  function failMount(card, error) {
    card.dataset.mounted = "0";
    card.querySelector(".mount-state").textContent = "Failed";
    card.querySelector(".extras").textContent = error && error.message ? error.message : "This method failed to mount.";
  }

  function setVideo(id, source, startAt) {
    videoId = id;
    linkStartSeconds = startAt || 0;
    sessionStorage.setItem("vpt-video", id);
    const url = new URL(location.href);
    url.searchParams.set("v", id);
    history.replaceState(null, "", url);
    document.getElementById("bench-title").textContent = id;
    document.getElementById("bench-sub").textContent = linkStartSeconds
      ? "Same video in every card. The link timestamp card uses " + linkStartSeconds + "s. Other timed cards keep their own start and end."
      : "Same video in every card. Scroll and each player lazy-mounts, or press Mount all.";
    const thumb = document.getElementById("now-thumb");
    thumb.hidden = false;
    thumb.src = "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
    const live = document.getElementById("live-status");
    live.classList.add("is-on");
    live.textContent = source === "phone" ? "Linked from the phone" : source === "saved" ? "Restored" : "Linked on this screen";
    document.getElementById("mount-all").disabled = false;
    document.getElementById("clear-video").disabled = false;
    document.title = id + " · Video Player Tester";
    document.querySelectorAll(".card").forEach((card) => {
      observer.unobserve(card);
      destroyPlayer(card);
      showPoster(card);
      if (!card.classList.contains("is-out")) observer.observe(card);
    });
  }

  function acceptLink(raw, source) {
    const id = parseYouTubeId(raw);
    if (!id) return false;
    setVideo(id, source, parseStartSeconds(raw));
    return true;
  }

  function buildChips() {
    const wrap = document.getElementById("chips");
    const categories = ["All"].concat(Array.from(new Set(METHODS.map((method) => method.category))));
    categories.forEach((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.textContent = category;
      button.setAttribute("aria-pressed", category === "All" ? "true" : "false");
      button.addEventListener("click", () => {
        activeCategory = category;
        wrap.querySelectorAll(".chip").forEach((chip) => {
          chip.setAttribute("aria-pressed", chip === button ? "true" : "false");
        });
        applyFilter();
      });
      wrap.append(button);
    });
  }

  function applyFilter() {
    const query = document.getElementById("filter-text").value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(".card").forEach((card) => {
      const categoryOk = activeCategory === "All" || card.dataset.cat === activeCategory;
      const textOk = !query || card.dataset.search.indexOf(query) >= 0;
      const visible = categoryOk && textOk;
      card.classList.toggle("is-out", !visible);
      if (visible) {
        shown += 1;
        if (videoId && card.dataset.mounted !== "1" && card.dataset.mounted !== "pending") observer.observe(card);
      } else {
        observer.unobserve(card);
      }
    });
    document.getElementById("count").textContent = "Showing " + shown + " of " + METHODS.length;
  }

  const seenRelayIds = new Set();

  function connectRelay() {
    const token = (relay = (relay || 0) + 1);
    const status = document.getElementById("relay-status");
    status.textContent = "Relay connecting…";
    status.classList.remove("is-ok");
    let since = Math.floor(Date.now() / 1000) - 1;
    pumpRelay(token, since, status);
  }

  async function pumpRelay(token, since, status) {
    while (relay === token) {
      try {
        const response = await fetch("https://ntfy.sh/" + topic() + "/json?poll=1&since=" + since);
        if (!response.ok) throw new Error(String(response.status));
        const text = await response.text();
        status.textContent = "Phone relay connected";
        status.classList.add("is-ok");
        text.split("\n").forEach((line) => {
          if (!line.trim()) return;
          let payload;
          try { payload = JSON.parse(line); } catch { return; }
          if (payload.time) since = Math.max(since, payload.time);
          if (!payload.message || (payload.event && payload.event !== "message")) return;
          if (payload.id && seenRelayIds.has(payload.id)) return;
          if (payload.id) seenRelayIds.add(payload.id);
          const box = document.getElementById("desk-msg");
          if (!acceptLink(payload.message, "phone")) {
            setMessage(box, "The phone sent something that is not a YouTube link.", true);
          } else {
            setMessage(box, "", false);
          }
        });
      } catch (error) {
        status.textContent = "Relay reconnecting… Paste on this screen if it stays down.";
        status.classList.remove("is-ok");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  function setMessage(node, text, isError) {
    node.textContent = text;
    node.classList.toggle("is-error", Boolean(isError) && Boolean(text));
  }

  if (isRemote) initRemote();
  else initDesk();
})();
