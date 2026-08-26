"use strict";
(() => {
  const EXT_TO_MIME = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    "3gp": "video/3gpp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav"
  };

  function mimeForName(name) {
    const ext = (name.toLowerCase().split(".").pop() || "");
    return EXT_TO_MIME[ext] || "application/octet-stream";
  }

  // Streams the zip in, throttling progress pings to background.js to ~150ms so a
  // fast connection doesn't flood chrome.runtime.sendMessage with hundreds of calls.
  async function readWithProgress(body, total, jobId) {
    const reader = body.getReader();
    const chunks = [];
    let received = 0;
    let lastReport = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value);
        received += value.length;
        const now = Date.now();
        if (jobId && (now - lastReport > 150 || received === total)) {
          lastReport = now;
          chrome.runtime.sendMessage({ type: "UNZIP_PROGRESS", jobId, received, total }).catch(() => {});
        }
      }
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async function unzipArtifact(msg) {
    try {
      // api.github.com answers with a 302 to storage. Chrome drops the Authorization
      // header on the cross-origin hop, which is exactly what the storage host wants.
      const res = await fetch(msg.url, {
        headers: {
          Authorization: `Bearer ${msg.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!res.ok) return { ok: false, error: `הורדת ה-artifact נכשלה (HTTP ${res.status})` };

      // fetch() follows the redirect itself, and res.url is the URL it actually
      // landed on — the pre-signed blob-storage link, not api.github.com. That link
      // needs no Authorization header (see the comment above), so it's exactly what
      // an external tool like IDM needs; hand it to background.js as soon as it's
      // known rather than waiting for the whole zip to finish downloading.
      if (msg.jobId && res.url && res.url !== msg.url) {
        chrome.runtime.sendMessage({ type: "UNZIP_DIRECT_URL", jobId: msg.jobId, url: res.url }).catch(() => {});
      }

      const totalHeader = res.headers.get("content-length");
      const total = totalHeader ? parseInt(totalHeader, 10) : 0;
      const zipped = await readWithProgress(res.body, total, msg.jobId);
      const entries = fflate.unzipSync(zipped);
      const files = [];
      for (const [name, data] of Object.entries(entries)) {
        if (!data || !data.length || name.endsWith("/")) continue;
        const blob = new Blob([data], { type: mimeForName(name) });
        files.push({ name, size: data.length, blobUrl: URL.createObjectURL(blob) });
      }
      if (!files.length) return { ok: false, error: "הארכיון שהתקבל ריק" };
      return { ok: true, files };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return undefined;
    if (message.type === "UNZIP_ARTIFACT") {
      unzipArtifact(message).then(sendResponse);
      return true;
    }
    if (message.type === "REVOKE") {
      try {
        URL.revokeObjectURL(message.blobUrl);
      } catch {
        /* already gone */
      }
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });
})();
