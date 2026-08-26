"use strict";

// config.js is local-only (it holds the token and the cookie key), so a checkout
// without it still has to load: the built-in blanks below keep the worker alive and
// the options page fills the rest in.
const BUILTIN_CONFIG = {
  owner: "",
  repo: "",
  workflow: "download.yml",
  ref: "main",
  token: "",
  cookieKey: "",
  updateOwner: "",
  updateRepo: ""
};
try {
  importScripts("config.js");
} catch {
  /* no local config.js — everything comes from the options page */
}
const DEFAULTS = { ...BUILTIN_CONFIG, ...(self.DEFAULT_CONFIG || {}) };

const API = "https://api.github.com";
const CFG_KEY = "ytproxy_cfg";
const JOBS_KEY = "ytproxy_jobs";

// The extension's own CODE update source lives in config.js (updateOwner/updateRepo),
// NOT hardcoded here — so this code file carries no personal identifier and the clean
// shareable build stays clean. It's read from config so it persists across updates
// (config.js is never overwritten) and each install can point wherever it likes.
// Only code is ever fetched from there, never a config, so nothing personal crosses
// between installs.
// Native-messaging host that runs update.bat on disk — registered once by
// install-updater.bat. The extension can't run a local script itself; this is the
// only sanctioned bridge.
const UPDATE_HOST = "com.rafi.ytproxy.updater";
const UPDATE_STATE_KEY = "ytproxy_update";

/* ------------------------------------------------------------------ config */

async function getConfig() {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const cfg = { ...DEFAULTS, ...stored };
  cfg.owner = (cfg.owner || "").trim();
  cfg.repo = (cfg.repo || "").trim();
  cfg.workflow = (cfg.workflow || "download.yml").trim();
  cfg.ref = (cfg.ref || "main").trim();
  cfg.token = (cfg.token || "").trim();
  cfg.cookieKey = (cfg.cookieKey || "").trim();
  cfg.updateOwner = (cfg.updateOwner || "").trim();
  cfg.updateRepo = (cfg.updateRepo || "").trim();
  return cfg;
}

async function setConfig(patch) {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const next = { ...stored, ...patch };
  await chrome.storage.local.set({ [CFG_KEY]: next });
  return getConfig();
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

/* ------------------------------------------------------------------- utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// chrome.downloads.download accepts subdirectories, so a collection's album/ folders
// are preserved rather than flattened — this used to do .pop() and keep only the
// basename, which silently threw away the per-album structure the zip was built with.
// Each segment is sanitized separately; "." and ".." are dropped so nothing can escape
// the Downloads directory.
function sanitizeFilename(name) {
  const segments = String(name || "")
    .split(/[\\/]+/)
    .map((seg) =>
      seg
        .replace(/[<>:"|?*\x00-\x1f]/g, "_")
        .replace(/^\.+/, "")
        .replace(/[ .]+$/, "") // Windows silently drops trailing dots/spaces
        .slice(0, 150)
    )
    .filter((seg) => seg && seg !== "." && seg !== "..");
  return segments.length ? segments.join("/") : "download";
}

function formatBytes(n) {
  if (!n || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/* ----------------------------------------------------------------- cookies */

const COOKIE_DOMAINS = ["youtube.com", "google.com"];

// The auth cookies yt-dlp actually needs for a logged-in YouTube session. Everything
// else on google.com (ads, analytics, consent, per-product prefs) is dropped — that
// bulk is what pushed the payload over the size limit ("cookies too large"). Every
// cookie on youtube.com is kept; from google.com only these login cookies are kept.
const YT_AUTH_COOKIES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  "SIDCC", "PREF", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA", "YSC",
  "__Secure-YEC", "CONSENT", "SOCS"
]);

function cookieHost(domain) {
  return domain.replace(/^\./, "");
}

// Keep it if it's on youtube.com (any of it), or it's one of the essential Google
// login cookies. This is the "YouTube-only" filter: it strips the google.com noise
// while preserving what's needed to stay signed in.
function isRelevantCookie(c) {
  const host = cookieHost(c.domain);
  if (host === "youtube.com" || host.endsWith(".youtube.com")) return true;
  return YT_AUTH_COOKIES.has(c.name);
}

async function exportYoutubeCookies() {
  if (!chrome.cookies || !chrome.cookies.getAll) return null;
  try {
    const groups = await Promise.all(COOKIE_DOMAINS.map((domain) => chrome.cookies.getAll({ domain })));
    const seen = new Set();
    const lines = ["# Netscape HTTP Cookie File"];
    for (const c of groups.flat()) {
      if (!isRelevantCookie(c)) continue;
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let domain = c.domain;
      if (!c.hostOnly && !domain.startsWith(".")) domain = `.${domain}`;
      const includeSub = c.hostOnly ? "FALSE" : "TRUE";
      const secure = c.secure ? "TRUE" : "FALSE";
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      const prefix = c.httpOnly ? "#HttpOnly_" : "";
      lines.push(`${prefix}${domain}\t${includeSub}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
    }
    return lines.length > 1 ? `${lines.join("\n")}\n` : null;
  } catch {
    return null;
  }
}

// The repo is public, so anything that lands in a workflow input can end up on a
// publicly readable run page. Cookies are live session credentials, so they travel
// encrypted and are only decrypted inside the job with the COOKIE_KEY repo secret.
async function encryptCookies(text, hexKey) {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) throw new Error("COOKIE_KEY חייב להיות 32 בייטים (64 תווי hex)");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  return bytesToB64(blob);
}

/* -------------------------------------------------------------- job state */

const jobs = new Map();
const driving = new Set();

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function persistJobs() {
  const plain = {};
  for (const [id, job] of jobs) plain[id] = job;
  try {
    await chrome.storage.session.set({ [JOBS_KEY]: plain });
  } catch {
    /* storage.session is best effort only */
  }
}

async function restoreJobs() {
  if (jobs.size) return;
  try {
    const plain = (await chrome.storage.session.get(JOBS_KEY))[JOBS_KEY] || {};
    for (const [id, job] of Object.entries(plain)) jobs.set(id, job);
  } catch {
    /* ignore */
  }
}

function patchJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  void persistJobs();
  return job;
}

/* ------------------------------------------------------------ github calls */

function ghFetch(url, cfg, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...ghHeaders(cfg.token), ...(init.headers || {}) }
  });
}

async function ghError(res, fallback) {
  let message = fallback;
  try {
    const body = await res.json();
    if (body && body.message) message = body.message;
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) return "הטוקן לא תקין או פג תוקף";
  if (res.status === 403) return `אין הרשאה: ${message}`;
  if (res.status === 404) return "לא נמצא — בדקו owner/repo/שם הוורקפלואו והרשאות הטוקן";
  return `${message} (HTTP ${res.status})`;
}

async function dispatchWorkflow(cfg, inputs) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`;
  const res = await ghFetch(url, cfg, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: cfg.ref, inputs })
  });
  if (res.status !== 204) throw new Error(await ghError(res, "שליחת הבקשה נכשלה"));
}

// The run is matched by its run-name (dl-<requestId>), which the workflow builds
// from the request_id input. That is what keeps parallel downloads from crossing.
async function findRun(cfg, requestId, signal, dispatchedAt) {
  const target = `dl-${requestId}`;
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs?event=workflow_dispatch&per_page=40`;
  // GitHub only evaluates run-name (our "dl-<id>" title) once a run actually STARTS —
  // while it sits queued its title is just the workflow name ("download"). So matching
  // on the title alone finds nothing until GitHub schedules the run, and when GitHub is
  // slow that produced a bogus "run not found" for a run that existed and was fine.
  // Confirmed live: a queued run reported display_title "download" and only became
  // "dl-diag-coll-1" after it started, ~90s later.
  //
  // So: prefer the exact title (unambiguous), and otherwise adopt a not-yet-completed
  // run of this workflow created after we dispatched that no other job has claimed.
  const since = (dispatchedAt || Date.now()) - 20000;
  for (let i = 0; i < 200; i += 1) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(url, cfg);
    if (res.ok) {
      const body = await res.json();
      const runs = body.workflow_runs || [];
      const exact = runs.find((r) => r.display_title === target || r.name === target);
      if (exact) return exact.id;
      // Ignore runs another job is already tracking, so two parallel downloads can
      // never be attached to each other's run.
      const taken = new Set(
        Array.from(jobs.values())
          .map((j) => j.runId)
          .filter(Boolean)
      );
      const candidates = runs.filter(
        (r) =>
          !taken.has(r.id) &&
          r.status !== "completed" &&
          (r.path || "").endsWith(cfg.workflow) &&
          new Date(r.created_at).getTime() >= since
      );
      // Only adopt when exactly one candidate fits — ambiguity means we keep waiting
      // for the title instead of guessing.
      if (candidates.length === 1) return candidates[0].id;
    }
    await sleep(i < 20 ? 800 : 2500);
  }
  throw new Error("הריצה לא נמצאה — בדקו בטאב Actions בריפו");
}

// Hebrew labels for the workflow's own step names, so "synced with GitHub" reads as
// actual GitHub step names rather than a generic "running…". Falls back to the raw
// name (with "…") for anything not in this list, so new steps still show something.
const RUN_STEP_LABELS = {
  "Set up job": "מתחיל את הריצה…",
  "Validate request id": "בודק את הבקשה…",
  "Set up Deno": "מתקין Deno…",
  "Install yt-dlp + ffmpeg": "מתקין yt-dlp ו-ffmpeg…",
  "Decrypt cookies": "מפענח עוגיות…",
  Download: "מוריד עם yt-dlp…",
  "Always drop cookies": "מנקה קבצים זמניים…",
  "Upload artifact": "מעלה את הקובץ ל-GitHub…",
  "Complete job": "מסיים את הריצה…"
};

// Up to 3 pages (300 jobs) — comfortably covers the 200-item collection cap plus
// enumerate/package/resolve-video.
async function fetchAllRunJobs(cfg, runId) {
  const all = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, cfg);
    if (!res.ok) break;
    const body = await res.json();
    const batch = body.jobs || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Collection mode fans out one GitHub job per item (see download.yml) specifically so
// this can exist: GitHub's API reports whole-job completion, so counting how many of
// those per-item jobs are done gives real "X of Y downloaded" progress — something no
// single step, however it's split up, can ever expose while it's still running.
// Pulls the actual ::error:: message a failed run printed (GitHub surfaces those as
// check-run annotations), so the extension can show "this channel has no videos"
// instead of a bare "run failed — open Actions". Best effort; returns null on any hitch.
async function fetchRunErrorMessage(cfg, runId) {
  try {
    const jobsList = await fetchAllRunJobs(cfg, runId);
    for (const job of jobsList) {
      if (job.conclusion && job.conclusion !== "success" && job.check_run_url) {
        const res = await ghFetch(`${job.check_run_url}/annotations`, cfg);
        if (!res.ok) continue;
        const annotations = (await res.json()) || [];
        // GitHub always adds a generic "Process completed with exit code N" annotation;
        // the useful one is our own ::error:: text, so skip the boilerplate.
        const meaningful = annotations
          .map((a) => (a.message || "").trim())
          .filter((m) => m && !/^Process completed with exit code/i.test(m));
        if (meaningful.length) return meaningful[0];
      }
    }
  } catch {
    /* best effort */
  }
  return null;
}

async function fetchRunProgress(cfg, runId, mode) {
  const allJobs = await fetchAllRunJobs(cfg, runId);
  if (!allJobs.length) return null;

  if (mode === "collection" || mode === "list") {
    const items = allJobs.filter((j) => j.name && j.name.startsWith("download-item "));
    if (!items.length) {
      const enumJob = allJobs.find((j) => j.name === "enumerate");
      if (!enumJob || enumJob.status !== "completed") {
        return { total: 0, completed: 0, label: mode === "list" ? "מתכנן את ההורדות…" : "סופר כמה פריטים יש בערוץ…" };
      }
      return null;
    }
    const succeeded = items.filter((j) => j.status === "completed" && j.conclusion === "success").length;
    const failed = items.filter((j) => j.status === "completed" && j.conclusion !== "success").length;
    const packaging = allJobs.some((j) => j.name === "package" && j.status !== "queued");
    const label = packaging
      ? "אורז הכל ל-ZIP אחד…"
      : `${succeeded} מתוך ${items.length} חלקים ירדו` + (failed ? ` (${failed} נכשלו)` : "");
    return { total: items.length, completed: succeeded + failed, label };
  }

  const ghJob = allJobs[0];
  const steps = ghJob && ghJob.steps;
  if (!steps || !steps.length) return null;
  const total = steps.length;
  const completed = steps.filter((s) => s.status === "completed").length;
  const active = steps.find((s) => s.status === "in_progress");
  const label = active ? RUN_STEP_LABELS[active.name] || `${active.name}…` : null;
  return { total, completed, label };
}

async function waitForRun(cfg, runId, onTick, signal, mode) {
  for (let i = 0; i < 600; i += 1) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}`, cfg);
    if (!res.ok) throw new Error(await ghError(res, "בדיקת סטטוס הריצה נכשלה"));
    const run = await res.json();
    const steps = run.status === "in_progress" ? await fetchRunProgress(cfg, runId, mode).catch(() => null) : null;
    onTick(run, steps);
    if (run.status === "completed") return run.conclusion;
    await sleep(5000);
  }
  throw new Error("הריצה לא הסתיימה בזמן סביר");
}

async function findArtifact(cfg, runId, requestId) {
  const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/artifacts`, cfg);
  if (!res.ok) throw new Error(await ghError(res, "שליפת ה-artifact נכשלה"));
  const body = await res.json();
  const list = body.artifacts || [];
  const found = list.find((a) => a.name === `dl-${requestId}`);
  if (!found) throw new Error("לא נוצר קובץ בריצה הזו");
  return found;
}

async function cancelRun(cfg, runId) {
  const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/cancel`, cfg, { method: "POST" });
  return res.ok || res.status === 202;
}

// The workflow also publishes the finished file as a GitHub Release asset, served from
// github.com/...githubusercontent.com — the same domains the self-updater already pulls
// from successfully behind Netfree, unlike the Actions artifact CDN (Azure blob) which
// Netfree blocks. Returns [{name, url, size}] or null if no release yet (older workflow,
// or GitHub hasn't indexed the tag — the caller retries a couple of times).
async function findReleaseAssets(cfg, requestId) {
  const res = await ghFetch(
    `${API}/repos/${cfg.owner}/${cfg.repo}/releases/tags/dl-${requestId}`,
    cfg
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const body = await res.json();
  const assets = (body.assets || [])
    .filter((a) => a.browser_download_url)
    .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size || 0 }));
  return assets.length ? assets : null;
}

/* ------------------------------------------------------------ recovery sync */

// chrome.storage.session (where jobs live) doesn't survive a browser restart, and an
// extension reload during development can wipe it too — but the run itself keeps
// going on GitHub regardless. This picks up any workflow_dispatch run that's still
// actually in flight (not tracked locally yet) and re-attaches to it, so reloading
// the extension mid-download reconnects instead of losing track of it. Runs GitHub
// itself already finished are deliberately left alone — those were either already
// saved, or the extension never got the chance to and re-fetching them unprompted
// would just silently re-save an old file the user didn't ask for again.
let lastGithubSync = 0;
async function syncRunsFromGitHub() {
  const now = Date.now();
  if (now - lastGithubSync < 15000) return;
  lastGithubSync = now;

  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) return;

  try {
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs?event=workflow_dispatch&per_page=20`, cfg);
    if (!res.ok) return;
    const body = await res.json();
    let added = false;
    for (const run of body.workflow_runs || []) {
      if (run.status === "completed") continue; // only reconnect to runs still in flight
      const match = /^dl-(.+)$/.exec(run.display_title || run.name || "");
      if (!match) continue;
      const requestId = match[1];
      if (jobs.has(requestId)) continue;
      // The original mode isn't retrievable after dispatch (GitHub doesn't expose
      // workflow_dispatch inputs post-hoc), but the job names it actually created do
      // give it away — collection mode has "enumerate"/"download-item "/"package".
      const runJobs = await fetchAllRunJobs(cfg, run.id).catch(() => []);
      const mode = runJobs.some((j) => j.name === "enumerate" || (j.name && j.name.startsWith("download-item ")))
        ? "collection"
        : "video";
      jobs.set(requestId, {
        id: requestId,
        requestId,
        url: "",
        title: `ריצה משוחזרת (${run.display_title})`,
        quality: null,
        mode,
        status: "running",
        detail: "התחברתי מחדש לריצה קיימת ב-GitHub…",
        percent: 15,
        runId: run.id,
        startedAt: new Date(run.created_at).getTime() || Date.now(),
        withCookies: false,
        files: [],
        recovered: true
      });
      added = true;
    }
    if (added) await persistJobs();
  } catch {
    /* best effort — a failed sync just means it tries again on the next call */
  }
}

/* ------------------------------------------------------ offscreen unzipper */

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "פריקת ה-ZIP של ה-artifact ויצירת blob URL לשמירה — לא זמין ב-service worker"
    });
  })();
  try {
    await offscreenReady;
  } catch (err) {
    offscreenReady = null;
    throw err;
  }
  return offscreenReady;
}

async function unpackArtifact(cfg, artifactId, jobId) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "UNZIP_ARTIFACT",
    jobId,
    url: `${API}/repos/${cfg.owner}/${cfg.repo}/actions/artifacts/${artifactId}/zip`,
    token: cfg.token
  });
  if (!res || !res.ok) throw new Error((res && res.error) || "פריקת הקובץ נכשלה");
  return res.files;
}

function revokeBlob(blobUrl) {
  // Only blob: URLs need revoking (and only those spin up the offscreen doc); a plain
  // https release URL saved via chrome.downloads has nothing to revoke.
  if (typeof blobUrl !== "string" || !blobUrl.startsWith("blob:")) return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", blobUrl }).catch(() => {});
}

// Chrome ignores the `filename` we pass for blob: downloads and names the file after
// the blob's UUID instead (observed: "8ca5e10f-....mp4" — it picked the extension up
// from the Blob's MIME type but dropped the name). onDeterminingFilename is the API
// built for this: it fires after Chrome has decided a tentative name and lets us
// replace it. Keyed by URL rather than download id, because it can fire before
// downloads.download()'s callback hands the id back.
const pendingNames = new Map(); // blobUrl -> filename we want on disk

if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const desired = pendingNames.get(item.url);
    if (!desired) {
      suggest(); // not ours — leave Chrome's choice alone
      return;
    }
    pendingNames.delete(item.url);
    suggest({ filename: desired, conflictAction: "uniquify" });
  });
}

// This has to run in the service worker: offscreen documents are restricted to the
// chrome.runtime APIs, so chrome.downloads is undefined there — trying to start the
// download from the document that owns the blob throws outright.
//
// onProgress(bytesReceived, totalBytes) is polled from chrome.downloads.search rather
// than driven by onChanged, since onChanged only fires on state transitions, not on
// every byte-count update — polling is the only way to get a moving number here.
function saveBlob(blobUrl, filename, onProgress) {
  return new Promise((resolve, reject) => {
    pendingNames.set(blobUrl, filename);
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        pendingNames.delete(blobUrl);
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "השמירה נכשלה"));
        return;
      }
      const pollTimer = setInterval(() => {
        chrome.downloads.search({ id: downloadId }, (items) => {
          const item = items && items[0];
          if (item && item.state === "in_progress" && onProgress) {
            onProgress(item.bytesReceived || 0, item.totalBytes || item.fileSize || 0);
          }
        });
      }, 400);
      const settle = (state) => {
        clearInterval(pollTimer);
        chrome.downloads.onChanged.removeListener(listener);
        revokeBlob(blobUrl);
        if (state !== "complete") {
          reject(new Error("ההורדה למחשב הופסקה"));
          return;
        }
        if (onProgress) onProgress(1, 1);
        // Report back the name Chrome actually wrote, not the one we asked for, so a
        // rename is visible rather than hidden behind the string we hoped for.
        chrome.downloads.search({ id: downloadId }, (items) => {
          const actual = items && items[0] && items[0].filename;
          resolve(actual ? actual.split(/[\\/]/).pop() : null);
        });
      };
      const listener = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current !== "complete" && delta.state.current !== "interrupted") return;
        settle(delta.state.current);
      };
      chrome.downloads.onChanged.addListener(listener);
      // A small file can finish before the listener is attached, so check once.
      chrome.downloads.search({ id: downloadId }, (items) => {
        const state = items && items[0] && items[0].state;
        if (state === "complete" || state === "interrupted") settle(state);
      });
    });
  });
}

/* ----------------------------------------------------------- job lifecycle */

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message
    });
  } catch {
    /* notifications are optional */
  }
}

async function driveJob(jobId) {
  if (driving.has(jobId)) return;
  driving.add(jobId);
  const job = jobs.get(jobId);
  if (!job) {
    driving.delete(jobId);
    return;
  }
  const signal = {
    get cancelled() {
      const j = jobs.get(jobId);
      return !j || j.status === "cancelled";
    }
  };

  try {
    const cfg = await getConfig();

    if (!job.runId) {
      patchJob(jobId, { status: "queued", detail: "ממתין שגיטהאב יתחיל את הריצה…", percent: 5 });
      const runId = await findRun(cfg, job.requestId, signal, job.dispatchedAt);
      patchJob(jobId, { runId });
    }

    patchJob(jobId, { status: "running", detail: "רץ ב-GitHub Actions…", percent: 10 });
    const conclusion = await waitForRun(
      cfg,
      jobs.get(jobId).runId,
      (run, steps) => {
        if (run.status === "queued") {
          patchJob(jobId, { detail: "בתור אצל GitHub…", percent: 8 });
          return;
        }
        if (run.status !== "in_progress") {
          patchJob(jobId, { detail: "הריצה הסתיימה", percent: 55 });
          return;
        }
        if (!steps || !steps.total) {
          // Either no progress signal yet, or (collection mode) still counting items
          // in the channel/playlist — steps.label carries that "counting…" message.
          patchJob(jobId, { detail: (steps && steps.label) || "רץ ב-GitHub Actions…", percent: 12 });
          return;
        }
        // GitHub only reports whole-job/whole-step completion, so between two of
        // those there's no real number to show — most visible on plain video mode's
        // single "Download" step, which might be 2 seconds or several minutes of
        // yt-dlp actually fetching, with nothing in between. Confirmed live: the
        // job's raw logs 404 while it's still running (GitHub only exposes them once
        // the job completes), so there's no way to read yt-dlp's own progress output
        // mid-run either. Collection mode gets real per-item granularity instead
        // (see fetchRunProgress) since each item is its own GitHub job; this easing
        // only matters there for the time within a single item's own download.
        const base = 10 + Math.floor(45 * (steps.completed / steps.total));
        const next = 10 + Math.floor((45 * Math.min(steps.total, steps.completed + 1)) / steps.total);
        const job = jobs.get(jobId);
        if (job.stepBase !== base) patchJob(jobId, { stepBase: base, stepNext: next, stepSince: Date.now() });
        const since = jobs.get(jobId).stepSince || Date.now();
        const elapsedSec = (Date.now() - since) / 1000;
        const eased = base + (next - base) * (1 - Math.exp(-elapsedSec / 15)) * 0.92;
        patchJob(jobId, { detail: steps.label || "רץ ב-GitHub Actions…", percent: Math.round(eased) });
      },
      signal,
      job.mode
    );

    if (conclusion === "cancelled") {
      patchJob(jobId, { status: "cancelled", detail: "הריצה בוטלה" });
      return;
    }
    if (conclusion !== "success") {
      const reason = await fetchRunErrorMessage(cfg, jobs.get(jobId).runId);
      throw new Error(reason || `הריצה נכשלה (${conclusion || "ללא מסקנה"}) — פתחו את הריצה ב-Actions לפירוט`);
    }

    patchJob(jobId, { status: "fetching", detail: "מושך את הקובץ מ-GitHub…", percent: 55 });

    // Primary path: the run's Release asset(s), downloaded straight from github.com
    // (works behind Netfree, and the file is already the final mp4/zip — no unzip).
    // A freshly-created release can take a moment to be findable by tag, so retry.
    let files = null; // [{name, url}] release, or [{name, blobUrl}] artifact fallback
    for (let attempt = 0; attempt < 6 && !files; attempt += 1) {
      const assets = await findReleaseAssets(cfg, job.requestId).catch(() => null);
      if (assets) {
        files = assets;
        patchJob(jobId, { directUrl: assets[0].url }); // copyable link for IDM etc.
        break;
      }
      await sleep(2000);
    }

    // Fallback (e.g. a repo whose workflow predates releases): the Actions artifact,
    // fetched from the Azure blob CDN and unzipped in the offscreen document.
    if (!files) {
      const artifact = await findArtifact(cfg, jobs.get(jobId).runId, job.requestId);
      files = await unpackArtifact(cfg, artifact.id, jobId);
    }

    patchJob(jobId, { status: "saving", detail: "שומר במחשב…", percent: 85 });
    const saved = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const filename = sanitizeFilename(file.name);
      const source = file.url || file.blobUrl; // release URL or unzipped blob
      const actualName = await saveBlob(source, filename, (received, total) => {
        const frac = total ? received / total : 0;
        const base = 85 + Math.floor((15 * i) / files.length);
        const span = 15 / files.length;
        patchJob(jobId, {
          percent: Math.min(99, base + Math.floor(span * frac)),
          detail: total
            ? `שומר במחשב: ${formatBytes(received)} מתוך ${formatBytes(total)}`
            : "שומר במחשב…"
        });
      });
      saved.push(actualName || filename.split("/").pop());
    }

    patchJob(jobId, { status: "completed", detail: "הקובץ נשמר במחשב", files: saved, percent: 100 });
    notify("ההורדה הסתיימה", saved[0] || job.title || job.url);
  } catch (err) {
    const current = jobs.get(jobId);
    if (current && current.status === "cancelled") return;
    const message = err instanceof Error ? err.message : String(err);
    patchJob(jobId, { status: "failed", detail: message, error: message });
    notify("ההורדה נכשלה", message);
  } finally {
    driving.delete(jobId);
  }
}

async function startDownload(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo) return { ok: false, error: "חסרים owner/repo — פתחו את ההגדרות" };
  if (!cfg.token) return { ok: false, error: "לא הוגדר טוקן GitHub — פתחו את ההגדרות" };
  if (!cfg.cookieKey) return { ok: false, error: "לא הוגדר COOKIE_KEY — פתחו את ההגדרות" };

  const requestId = crypto.randomUUID();
  const jobId = requestId;

  let cookiesEnc = "";
  const cookies = await exportYoutubeCookies();
  if (cookies) {
    try {
      cookiesEnc = await encryptCookies(cookies, cfg.cookieKey);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // workflow_dispatch caps its inputs; fail with something readable instead of
    // letting GitHub answer with an opaque 422.
    if (cookiesEnc.length > 60000) {
      return {
        ok: false,
        error: "העוגיות עדיין גדולות מדי אחרי הסינון — נקו עוגיות יוטיוב ישנות בדפדפן והתחברו מחדש, ונסו שוב"
      };
    }
  }

  const mode =
    payload.mode === "collection" ? "collection" : payload.mode === "list" ? "list" : "video";

  // list mode: several explicit URLs downloaded together in one batched run (like a
  // channel). The workflow reads them from the `urls` input; `url` still carries a
  // representative one because that input is required.
  let urlsJson = "";
  let repUrl = payload.url;
  if (mode === "list") {
    const list = (payload.urls || []).map((u) => String(u).trim()).filter(Boolean);
    if (!list.length) return { ok: false, error: "לא התקבלו קישורים" };
    urlsJson = JSON.stringify(list);
    repUrl = list[0];
    if (urlsJson.length > 60000) {
      return { ok: false, error: "יותר מדי קישורים בבת אחת — פצלו לכמה הורדות ונסו שוב" };
    }
  }

  jobs.set(jobId, {
    id: jobId,
    requestId,
    url: repUrl,
    title:
      payload.title ||
      (mode === "list" ? `${JSON.parse(urlsJson).length} קישורים` : payload.url),
    quality: payload.quality,
    mode,
    status: "preparing",
    detail: "שולח בקשה ל-GitHub…",
    percent: 2,
    runId: null,
    startedAt: Date.now(),
    // Stamped before the dispatch call so findRun can tell "a run created after we
    // asked" from older runs, and adopt ours while it is still queued (GitHub does not
    // set the dl-<id> title until the run starts).
    dispatchedAt: Date.now(),
    withCookies: Boolean(cookiesEnc),
    files: []
  });
  await persistJobs();

  try {
    await dispatchWorkflow(cfg, {
      request_id: requestId,
      url: repUrl,
      quality: payload.quality,
      mode,
      urls: urlsJson,
      cookies_enc: cookiesEnc
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchJob(jobId, { status: "failed", detail: message, error: message });
    return { ok: false, error: message, jobId };
  }

  void driveJob(jobId);
  return { ok: true, jobId };
}

async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo) return { ok: false, error: "חסרים owner/repo" };
  if (!cfg.token) return { ok: false, error: "חסר טוקן" };
  const res = await ghFetch(
    `${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}`,
    cfg
  );
  if (!res.ok) return { ok: false, error: await ghError(res, "החיבור נכשל") };
  const wf = await res.json();
  return { ok: true, detail: `${cfg.owner}/${cfg.repo} · ${wf.name || cfg.workflow} · ${wf.state}` };
}

/* ------------------------------------------------------------ self-update */

// Compares dotted version strings: returns true if `remote` is newer than `local`.
function isNewerVersion(remote, local) {
  const r = String(remote).split(".").map((n) => parseInt(n, 10) || 0);
  const l = String(local).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i += 1) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function checkForUpdate() {
  const local = chrome.runtime.getManifest().version;
  const cfg = await getConfig();
  if (!cfg.updateOwner || !cfg.updateRepo) {
    // No update source configured (e.g. the clean shareable build) — nothing to check.
    const state = { available: false, local, remote: null, disabled: true, checkedAt: Date.now() };
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
    return { ok: true, ...state };
  }
  const manifestUrl = `https://raw.githubusercontent.com/${cfg.updateOwner}/${cfg.updateRepo}/main/extension/manifest.json`;
  try {
    // cache: no-store so a checkout doesn't get a stale CDN copy and miss an update
    const res = await fetch(manifestUrl, { cache: "no-store" });
    if (!res.ok) return { ok: false, local };
    const remoteManifest = await res.json();
    const remote = remoteManifest.version;
    const available = Boolean(remote) && isNewerVersion(remote, local);
    const state = { available, local, remote: remote || null, checkedAt: Date.now() };
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
    if (available) void maybeAutoUpdate();
    return { ok: true, ...state };
  } catch {
    return { ok: false, local };
  }
}

let autoUpdateAt = 0;
function hasActiveJobs() {
  for (const job of jobs.values()) {
    if (!TERMINAL.has(job.status)) return true;
  }
  return false;
}

// Applies an available update on its own — no button press needed. Held back only
// while a download is in flight (a reload would kill it) and rate-limited so a failed
// attempt (e.g. the native host isn't installed yet) doesn't retry in a tight loop.
// If it can't run, the panel banner still offers the manual button as a fallback.
async function maybeAutoUpdate() {
  if (hasActiveJobs()) return;
  if (Date.now() - autoUpdateAt < 5 * 60 * 1000) return;
  autoUpdateAt = Date.now();
  await runUpdate(); // reloads the extension itself on success
}

async function getUpdateState() {
  const local = chrome.runtime.getManifest().version;
  const stored = (await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY];
  // A stored "available" flag can be stale after an update already applied — the newly
  // loaded manifest now matches remote — so re-derive availability against the running
  // version rather than trusting the flag alone.
  if (stored && stored.remote) {
    return { ...stored, local, available: isNewerVersion(stored.remote, local) };
  }
  return { available: false, local, remote: null };
}

// Fires the native host, which runs update.bat on disk and only replies once it's
// finished — so reloading here loads the freshly written files, not the old ones.
function runUpdate() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      chrome.runtime.sendNativeMessage(UPDATE_HOST, { action: "update" }, (response) => {
        if (chrome.runtime.lastError) {
          done({
            ok: false,
            error:
              "לא ניתן להריץ את מעדכן העדכונים. ודאו שהרצתם פעם אחת את install-updater.bat בתיקיית התוסף. (" +
              chrome.runtime.lastError.message +
              ")"
          });
          return;
        }
        if (response && response.ok) {
          done({ ok: true });
          // Give the disk writes a beat to flush, then reload to pick up new files.
          setTimeout(() => chrome.runtime.reload(), 800);
        } else {
          done({ ok: false, error: (response && response.error) || "העדכון נכשל" });
        }
      });
    } catch (err) {
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/* -------------------------------------------------------------- messaging */

async function handle(msg) {
  await restoreJobs();
  switch (msg.type) {
    case "GET_PREFS": {
      const cfg = await getConfig();
      return {
        configured: Boolean(cfg.owner && cfg.repo && cfg.token && cfg.cookieKey),
        owner: cfg.owner,
        repo: cfg.repo,
        defaultOption: cfg.defaultOption || "video_best"
      };
    }
    case "GET_UPDATE_STATE":
      return getUpdateState();
    case "CHECK_UPDATE":
      return checkForUpdate();
    case "RUN_UPDATE":
      return runUpdate();
    case "GET_CONFIG":
      return getConfig();
    case "SET_CONFIG":
      return setConfig(msg.patch);
    case "RESET_CONFIG":
      await chrome.storage.local.remove(CFG_KEY);
      return getConfig();
    case "TEST_CONNECTION":
      return testConnection();
    case "START_DOWNLOAD":
      return startDownload(msg.payload);
    case "LIST_JOBS": {
      await syncRunsFromGitHub();
      const plain = {};
      for (const [id, job] of jobs) plain[id] = job;
      for (const [id, job] of jobs) if (!TERMINAL.has(job.status)) void driveJob(id);
      return { ok: true, jobs: plain };
    }
    case "POLL_JOB": {
      const job = jobs.get(msg.jobId);
      if (!job) return { ok: false, error: "העבודה לא נמצאה" };
      if (!TERMINAL.has(job.status)) void driveJob(msg.jobId);
      return { ok: true, job };
    }
    case "CANCEL_JOB": {
      const job = jobs.get(msg.jobId);
      if (!job) return { ok: false, error: "העבודה לא נמצאה" };
      patchJob(msg.jobId, { status: "cancelled", detail: "מבטל…" });
      if (job.runId) {
        const cfg = await getConfig();
        await cancelRun(cfg, job.runId).catch(() => false);
      }
      patchJob(msg.jobId, { detail: "ההורדה בוטלה" });
      return { ok: true };
    }
    case "OPEN_RUN": {
      const job = jobs.get(msg.jobId);
      const cfg = await getConfig();
      const url =
        job && job.runId
          ? `https://github.com/${cfg.owner}/${cfg.repo}/actions/runs/${job.runId}`
          : `https://github.com/${cfg.owner}/${cfg.repo}/actions`;
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case "OPEN_DOWNLOADS":
      chrome.downloads.showDefaultFolder();
      return { ok: true };
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: `הודעה לא מוכרת: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return undefined;
  if (message.target === "offscreen") return undefined; // request headed to the offscreen doc
  if (message.type === "UNZIP_PROGRESS") {
    // Fire-and-forget progress ping from offscreen.js mid-fetch — no response needed,
    // it just nudges the job's percent while the artifact zip streams in.
    const job = jobs.get(message.jobId);
    if (job && !TERMINAL.has(job.status)) {
      const total = message.total;
      const frac = total ? Math.min(1, message.received / total) : 0;
      patchJob(message.jobId, {
        percent: 55 + Math.floor(30 * frac),
        detail: total
          ? `מוריד לדפדפן: ${formatBytes(message.received)} מתוך ${formatBytes(total)}`
          : `מוריד לדפדפן: ${formatBytes(message.received)}`
      });
    }
    return undefined;
  }
  if (message.type === "UNZIP_DIRECT_URL") {
    // The extension's own path (fetch → unzip → chrome.downloads) is still what runs
    // by default; this is only ever an opt-in extra the user can copy for a tool like
    // IDM instead. It's a pre-signed link, so it stops working once it expires —
    // typically a short window, not meant to be saved for later.
    const job = jobs.get(message.jobId);
    if (job) patchJob(message.jobId, { directUrl: message.url });
    return undefined;
  }
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

// No default_popup is set, so a toolbar click lands here — open (or refocus) one
// persistent tab instead. The download itself never depended on any UI staying
// open; this just makes it obvious the icon isn't a "cancel my downloads" button.
chrome.action.onClicked.addListener(async () => {
  const panelUrl = chrome.runtime.getURL("panel.html");
  const existing = await chrome.tabs.query({ url: panelUrl });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: panelUrl });
});

// The service worker can be torn down mid-run; this alarm picks any unfinished job
// back up instead of leaving it stuck on "running".
chrome.alarms.create("ytproxy-resume", { periodInMinutes: 1 });
// Check GitHub for a newer version of the extension a few times a day.
chrome.alarms.create("ytproxy-update-check", { periodInMinutes: 360, when: Date.now() + 5000 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "ytproxy-update-check") {
    await checkForUpdate();
    return;
  }
  if (alarm.name !== "ytproxy-resume") return;
  await restoreJobs();
  await syncRunsFromGitHub();
  for (const [id, job] of jobs) {
    if (!TERMINAL.has(job.status)) void driveJob(id);
  }
});
// Also check once right after install/update so the banner reflects reality promptly.
chrome.runtime.onInstalled.addListener(() => void checkForUpdate());
