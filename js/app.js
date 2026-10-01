(function () {
  const DEFAULT_ID = "RRxcfwAXVa8";
  const ALLOW = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";

  const params = new URLSearchParams(location.search);
  const isRemote = params.get("role") === "remote";
  let room = params.get("room");
  let videoId = parseYouTubeId(params.get("v")) || DEFAULT_ID;
  let linkStartSeconds = 0;
  let index = clampIndex(Number(params.get("m")));
  let gate = { on: true };
  let token = 0;
  let destroyCurrent = null;
  let relay = 0;
  const seenRelayIds = new Set();

  if (!isRemote) {
    if (!room) room = sessionStorage.getItem("vpt-room") || createRoom();
    sessionStorage.setItem("vpt-room", room);
    const url = new URL(location.href);
    url.searchParams.set("room", room);
    url.searchParams.set("v", videoId);
    url.searchParams.delete("role");
    history.replaceState(null, "", url);
  }

  const METHODS = [
    { id: "webcodecs", title: "WebCodecs → canvas", blurb: "Decoded frames on a canvas, sound on an audio element. No video tag.", mount: (ctx) => window.AltPlayers.mountWebCodecs(ctx) },
    { id: "storyboard", title: "Storyboard scrub", blurb: "YouTube preview sprites on a canvas, timed to audio. No video tag.", mount: (ctx) => window.AltPlayers.mountStoryboardCanvas(ctx) },
    { id: "sprite", title: "Image sprite stream", blurb: "One storyboard cell at a time through an img element, plus audio. No video tag.", mount: (ctx) => window.AltPlayers.mountStoryboardImg(ctx) },
    { id: "yt-api", title: "IFrame Player API", blurb: "Official player, volume 100, unmuted from this click.", mount: mountApi },
    { id: "iframe", title: "Standard iframe", blurb: "youtube.com/embed with autoplay and unmute commands.", mount: (ctx) => mountEmbed(ctx, {}) },
    { id: "nocookie", title: "youtube-nocookie iframe", blurb: "Privacy-enhanced embed host, same unmute commands.", mount: (ctx) => mountEmbed(ctx, { host: "www.youtube-nocookie.com" }) },
    { id: "srcdoc", title: "Nested srcdoc iframe", blurb: "Embed lives inside a srcdoc document.", mount: mountSrcdoc },
    { id: "shadow", title: "Shadow DOM iframe", blurb: "Embed attached inside a shadow root.", mount: mountShadow },
    { id: "object", title: "object element", blurb: "Embed loaded through an object element.", mount: (ctx) => mountPlugin(ctx, "object") },
    { id: "embed", title: "embed element", blurb: "Embed loaded through an embed element.", mount: (ctx) => mountPlugin(ctx, "embed") },
    { id: "svg", title: "SVG foreignObject", blurb: "Embed placed in an SVG foreignObject.", mount: mountSvg },
    { id: "credentialless", title: "Credentialless iframe", blurb: "Iframe without cookies. Often blocked by YouTube.", mount: (ctx) => mountEmbed(ctx, { credentialless: true }) },
    { id: "sandbox", title: "Sandboxed iframe", blurb: "Iframe with a sandbox attribute.", mount: (ctx) => mountEmbed(ctx, { sandbox: SANDBOX }) },
    { id: "noreferrer", title: "No-referrer iframe", blurb: "Embed sent with an empty referrer.", mount: (ctx) => mountEmbed(ctx, { referrerPolicy: "no-referrer" }) },
    { id: "legacy", title: "Legacy /v/ path", blurb: "Old Flash-era /v/ URL. Often refused.", mount: mountLegacy },
  ];

  function createRoom() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  }

  function clampIndex(value) {
    if (!Number.isFinite(value)) return 0;
    const count = 15;
    return ((value % count) + count) % count;
  }

  function topic() {
    return "vpt-" + room;
  }

  function remoteUrl() {
    const url = new URL(location.href);
    url.searchParams.set("room", room);
    url.searchParams.set("role", "remote");
    url.searchParams.delete("v");
    url.searchParams.delete("m");
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

  function youtubeEmbed(id, extra, host) {
    const url = new URL("https://" + (host || "www.youtube.com") + "/embed/" + id);
    const query = Object.assign({
      autoplay: "1",
      mute: "0",
      enablejsapi: "1",
      playsinline: "1",
      rel: "0",
      origin: location.origin,
    }, extra || {});
    if (linkStartSeconds) query.start = String(linkStartSeconds);
    Object.entries(query).forEach(([key, value]) => {
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
    frame.allowFullscreen = true;
    if (opts.sandbox) frame.setAttribute("sandbox", opts.sandbox);
    if (opts.credentialless) frame.credentialless = true;
    pumpUnmute(frame);
    return frame;
  }

  function pumpUnmute(frame) {
    const send = () => {
      const win = frame.contentWindow;
      if (!win) return;
      const packets = [
        { event: "listening", id: "vpt", channel: "widget" },
        { event: "command", func: "setVolume", args: [100] },
        { event: "command", func: "unMute", args: [] },
        { event: "command", func: "playVideo", args: [] },
      ];
      packets.forEach((packet) => {
        try { win.postMessage(JSON.stringify(packet), "*"); } catch (error) { /* cross-origin */ }
      });
    };
    frame.addEventListener("load", () => {
      [0, 400, 1200, 2500].forEach((ms) => setTimeout(send, ms));
    });
  }

  function mountEmbed(ctx, options) {
    const src = youtubeEmbed(ctx.videoId, {}, options.host);
    ctx.stage.append(makeFrame(src, ctx.title, options));
  }

  function mountSrcdoc(ctx) {
    const src = youtubeEmbed(ctx.videoId).replace(/&/g, "&amp;");
    const frame = document.createElement("iframe");
    frame.title = ctx.title;
    frame.srcdoc = "<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}</style></head><body><iframe src=\""
      + src + "\" allow=\"" + ALLOW + "\" allowfullscreen></iframe></body></html>";
    ctx.stage.append(frame);
  }

  function mountShadow(ctx) {
    const host = document.createElement("div");
    host.className = "fill-host";
    const root = host.attachShadow({ mode: "open" });
    const frame = makeFrame(youtubeEmbed(ctx.videoId), ctx.title);
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
    root.append(frame);
    ctx.stage.append(host);
  }

  function mountPlugin(ctx, tag) {
    const node = document.createElement(tag);
    const src = youtubeEmbed(ctx.videoId);
    if (tag === "object") node.data = src;
    else node.src = src;
    node.type = "text/html";
    node.title = ctx.title;
    ctx.stage.append(node);
  }

  function mountSvg(ctx) {
    const rect = ctx.stage.getBoundingClientRect();
    const width = Math.max(160, Math.round(rect.width));
    const height = Math.max(90, Math.round(rect.height));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    fo.setAttribute("width", String(width));
    fo.setAttribute("height", String(height));
    const wrap = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    wrap.style.cssText = "width:" + width + "px;height:" + height + "px;margin:0;background:#000";
    const frame = makeFrame(youtubeEmbed(ctx.videoId), ctx.title);
    frame.style.cssText = "width:100%;height:100%;border:0";
    wrap.append(frame);
    fo.append(wrap);
    svg.append(fo);
    ctx.stage.append(svg);
  }

  function mountLegacy(ctx) {
    const src = "https://www.youtube.com/v/" + ctx.videoId + "?autoplay=1&version=3";
    const embed = document.createElement("embed");
    embed.src = src;
    embed.type = "application/x-shockwave-flash";
    embed.title = ctx.title;
    ctx.stage.append(embed);
  }

  let ytReady;
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof previous === "function") previous();
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.append(script);
    });
    return ytReady;
  }

  function mountApi(ctx) {
    return loadYouTubeApi().then(() => {
      if (ctx.gate && ctx.gate.on === false) return;
      const slot = document.createElement("div");
      slot.className = "fill-host";
      ctx.stage.append(slot);
      const player = new window.YT.Player(slot, {
        videoId: ctx.videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          mute: 0,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          origin: location.origin,
          start: linkStartSeconds || undefined,
        },
        events: {
          onReady(event) {
            event.target.setVolume(100);
            event.target.unMute();
            event.target.playVideo();
          },
        },
      });
      ctx.bind({
        destroy() {
          try { player.destroy(); } catch (error) { /* already gone */ }
        },
      });
    });
  }

  function show(next) {
    index = ((next % METHODS.length) + METHODS.length) % METHODS.length;
    const mine = ++token;
    if (gate) gate.on = false;
    gate = { on: true };
    if (destroyCurrent) {
      try { destroyCurrent(); } catch (error) { /* already gone */ }
      destroyCurrent = null;
    }
    const stage = document.getElementById("stage");
    const extras = document.getElementById("extras");
    const status = document.getElementById("status");
    const now = document.getElementById("now");
    stage.replaceChildren();
    extras.replaceChildren();
    const method = METHODS[index];
    now.innerHTML = (index + 1) + " / " + METHODS.length + " · <b>" + method.title + "</b>";
    status.textContent = method.blurb;
    document.title = method.title + " · Video Player Tester";

    const url = new URL(location.href);
    url.searchParams.set("v", videoId);
    url.searchParams.set("m", String(index));
    history.replaceState(null, "", url);

    const ctx = {
      videoId: videoId,
      stage: stage,
      extras: extras,
      gate: gate,
      title: method.title,
      bind(player) {
        if (mine !== token) {
          try { player.destroy(); } catch (error) { /* stale */ }
          return;
        }
        destroyCurrent = function () { try { player.destroy(); } catch (error) { /* already gone */ } };
      },
    };

    Promise.resolve()
      .then(() => method.mount(ctx))
      .catch((error) => {
        if (mine !== token) return;
        status.textContent = error && error.message ? error.message : "This technique failed.";
      });
  }

  function step(delta) {
    show(index + delta);
  }

  function setVideo(id, startAt) {
    videoId = id;
    linkStartSeconds = startAt || 0;
    const input = document.getElementById("url");
    if (input) input.value = "https://www.youtube.com/watch?v=" + id;
    show(index);
  }

  function acceptLink(raw) {
    const id = parseYouTubeId(raw);
    if (!id) return false;
    setVideo(id, parseStartSeconds(raw));
    return true;
  }

  function connectRelay() {
    const mine = (relay += 1);
    const label = document.getElementById("relay");
    let since = Math.floor(Date.now() / 1000) - 1;
    (async function pump() {
      while (relay === mine) {
        try {
          const response = await fetch("https://ntfy.sh/" + topic() + "/json?poll=1&since=" + since);
          if (!response.ok) throw new Error(String(response.status));
          const text = await response.text();
          if (label) label.textContent = "Phone relay connected";
          text.split("\n").forEach((line) => {
            if (!line.trim()) return;
            let payload;
            try { payload = JSON.parse(line); } catch { return; }
            if (payload.time) since = Math.max(since, payload.time);
            if (!payload.message || (payload.event && payload.event !== "message")) return;
            if (payload.id && seenRelayIds.has(payload.id)) return;
            if (payload.id) seenRelayIds.add(payload.id);
            acceptLink(payload.message);
          });
        } catch (error) {
          if (label) label.textContent = "Relay reconnecting";
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })();
  }

  function drawQr(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    document.getElementById("qr").src = qr.createDataURL(6);
  }

  function initDesk() {
    document.getElementById("url").value = "https://www.youtube.com/watch?v=" + videoId;
    document.getElementById("room-code").textContent = room;
    document.getElementById("url-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = document.getElementById("url").value;
      if (!acceptLink(raw)) document.getElementById("status").textContent = "That is not a YouTube link.";
    });
    document.getElementById("prev").addEventListener("click", () => step(-1));
    document.getElementById("next").addEventListener("click", () => step(1));
    document.getElementById("phone").addEventListener("click", () => {
      const pop = document.getElementById("phone-pop");
      pop.hidden = !pop.hidden;
    });
    document.getElementById("copy-link").addEventListener("click", async () => {
      const link = remoteUrl();
      try {
        await navigator.clipboard.writeText(link);
        document.getElementById("relay").textContent = "Remote link copied";
      } catch (error) {
        document.getElementById("relay").textContent = link;
      }
    });
    document.addEventListener("keydown", (event) => {
      const tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (event.target && event.target.isContentEditable)) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
    });
    drawQr(remoteUrl());
    connectRelay();
    show(index);
  }

  function initRemote() {
    document.getElementById("remote-room").textContent = room || "missing";
    const form = document.getElementById("remote-form");
    const input = document.getElementById("remote-url");
    const msg = document.getElementById("remote-msg");
    document.getElementById("remote-paste").addEventListener("click", async () => {
      try {
        input.value = await navigator.clipboard.readText();
        msg.textContent = "";
      } catch (error) {
        msg.textContent = "Clipboard is blocked. Paste into the field.";
        msg.classList.add("bad");
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!room) {
        msg.textContent = "This remote has no session.";
        msg.classList.add("bad");
        return;
      }
      if (!parseYouTubeId(input.value)) {
        msg.textContent = "That is not a YouTube link.";
        msg.classList.add("bad");
        return;
      }
      msg.textContent = "Sending…";
      msg.classList.remove("bad");
      try {
        const response = await fetch("https://ntfy.sh/" + topic(), {
          method: "POST",
          body: input.value.trim(),
        });
        if (!response.ok) throw new Error(String(response.status));
        msg.textContent = "Sent. The screen will switch to this video.";
      } catch (error) {
        msg.textContent = "Send failed.";
        msg.classList.add("bad");
      }
    });
  }

  if (isRemote) initRemote();
  else initDesk();
})();
