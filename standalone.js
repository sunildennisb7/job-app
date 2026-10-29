/* Standalone runtime for the job tracker, so it runs as a normal website / iPhone app outside Claude.
   - db:        your data on this device, synced to your PRIVATE GitHub repo (app-data/tracker.json)
   - sample:    AI writing through Google Gemini with your own free API key
   - downloads: saves files from the browser
   Keys are kept only on this device (localStorage). */
(function () {
  "use strict";
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };
  const SETTINGS_KEY = "jobapp-settings";
  const DB_KEY = "jobapp-db";
  const DEFAULTS = { repo: "sunildennisb7/job-assistant", githubToken: "", geminiKey: "", model: "gemini-flash-latest" };

  function settings() {
    try { return { ...DEFAULTS, ...JSON.parse(LS.get(SETTINGS_KEY) || "{}") }; } catch (e) { return { ...DEFAULTS }; }
  }
  function saveSettings(s) { LS.set(SETTINGS_KEY, JSON.stringify({ ...settings(), ...s })); }

  function err(code, message) { const e = new Error(message || code); e.code = code; return e; }

  /* ---------------- base64 helpers (UTF-8 safe) ---------------- */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str); let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob((b64 || "").replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  /* ---------------- GitHub (private repo) ---------------- */
  const gh = {
    ready() { const s = settings(); return !!(s.githubToken && s.repo); },
    async req(path, opts = {}) {
      const s = settings();
      const res = await fetch(`https://api.github.com/repos/${s.repo}/${path}`, {
        ...opts,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${s.githubToken}`,
                   "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        cache: "no-store",
      });
      if (res.status === 404) return null;
      if (res.status === 401) throw err("bad_github_token", "GitHub token not accepted");
      if (res.status === 403) throw err("github_forbidden", "GitHub token can't access this repo");
      if (res.status === 409 || res.status === 422) throw err("conflict");
      if (!res.ok) throw err("github_" + res.status);
      return res.json();
    },
    /** Returns {text, sha} or null if the file doesn't exist. */
    async readFile(path) {
      const meta = await this.req(`contents/${path}`);
      if (!meta) return null;
      let content = meta.content;
      if (!content && meta.sha) { const blob = await this.req(`git/blobs/${meta.sha}`); content = blob && blob.content; }
      return { text: b64decode(content || ""), sha: meta.sha };
    },
    async writeFile(path, text, sha, message) {
      const body = { message, content: b64encode(text), ...(sha ? { sha } : {}) };
      const r = await this.req(`contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
      return r && r.content && r.content.sha;
    },
  };

  /* ---------------- Local database with Firestore-like API ---------------- */
  // records: { "collection/id": { d: data|null (null = deleted), t: ms, b: ms, f: { field: ms } } }
  // t = last change to the record, b = when the whole record was last replaced, f = when each field last changed.
  // Field times let edits to different fields of the same job on the Mac and the iPhone both survive a sync.
  let records = {};
  try { records = JSON.parse(LS.get(DB_KEY) || "{}").records || {}; } catch (e) { records = {}; }
  let clock = 0;
  for (const r of Object.values(records)) clock = Math.max(clock, r.t || 0);
  // Always later than anything this device has seen, so a new edit wins even if this device's clock is behind.
  const tick = () => (clock = Math.max(Date.now(), clock + 1));
  const listeners = new Set();
  let syncSha = null, dirty = false, pushTimer = null, syncing = null;
  const SYNC_PATH = "app-data/tracker.json";
  const syncState = { status: "local", message: "Saved on this device only", at: null };

  function persist() { LS.set(DB_KEY, JSON.stringify({ records })); }
  function notify() { queueMicrotask(() => { for (const l of [...listeners]) { try { l(); } catch (e) { console.error(e); } } }); }
  function setStatus(status, message) {
    syncState.status = status; syncState.message = message; syncState.at = new Date();
    window.dispatchEvent(new CustomEvent("jobapp-sync", { detail: { ...syncState } }));
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function write(path, data, fields) {
    const t = tick(), cur = records[path];
    if (data && fields && cur && cur.d) {
      // update(): only the fields that really changed get a new time.
      const f = { ...(cur.f || {}) };
      for (const k of fields) if (!same(cur.d[k], data[k])) f[k] = t;
      records[path] = { d: data, t, b: cur.b || cur.t, f };
    } else {
      records[path] = data ? { d: data, t, b: t } : { d: null, t };
    }
    persist(); notify(); schedulePush();
  }
  function docsIn(col) {
    const pre = col + "/";
    return Object.entries(records)
      .filter(([k, v]) => k.startsWith(pre) && v.d && !k.slice(pre.length).includes("/"))
      .map(([k, v]) => ({ id: k.slice(pre.length), data: () => JSON.parse(JSON.stringify(v.d)) }));
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function docRef(path) {
    const id = path.split("/").pop();
    return {
      id, path,
      async set(data) { write(path, { ...data }); },
      async update(data) { const cur = records[path] && records[path].d; write(path, { ...(cur || {}), ...data }, Object.keys(data)); },
      async delete() { write(path, null); },
      // For things the app adds by itself (alerts, inbox emails): if another device already has this record,
      // its copy wins, so an automatic import never undoes an edit made on the other device.
      async create(data) {
        if (records[path]) return;
        records[path] = { d: { ...data }, t: 1, b: 1 };
        persist(); notify(); schedulePush();
      },
      async get() { const r = records[path]; return { id, exists: !!(r && r.d), data: () => r && r.d ? JSON.parse(JSON.stringify(r.d)) : undefined }; },
      onSnapshot(cb, onErr) {
        const fire = () => { const r = records[path]; cb({ id, exists: !!(r && r.d), data: () => (r && r.d ? JSON.parse(JSON.stringify(r.d)) : undefined) }); };
        listeners.add(fire); queueMicrotask(fire);
        return () => listeners.delete(fire);
      },
    };
  }
  function collectionRef(name) {
    return {
      doc(id) { return docRef(`${name}/${id}`); },
      async add(data) { const id = newId(); write(`${name}/${id}`, { ...data }); return docRef(`${name}/${id}`); },
      async get() { return { docs: docsIn(name) }; },
      onSnapshot(cb, onErr) {
        const fire = () => cb({ docs: docsIn(name) });
        listeners.add(fire); queueMicrotask(fire);
        return () => listeners.delete(fire);
      },
    };
  }
  const db = { collection: collectionRef, doc: docRef };

  /* ---------------- Sync with the private repo ---------------- */
  const fieldTime = (rec, k) => (rec.f && rec.f[k]) || rec.b || rec.t || 0;
  /** Merges one record from this device (l) and from GitHub (r). */
  function mergeRecord(l, r) {
    if (!l) return r;
    if (!r) return l;
    // A delete, or a whole-record replace, wins over everything older than it.
    if (!l.d || !r.d) return (l.t || 0) >= (r.t || 0) ? l : r;
    const lb = l.b || l.t, rb = r.b || r.t;
    const keys = new Set([...Object.keys(l.d), ...Object.keys(r.d)]);
    const d = {}, f = {};
    for (const k of keys) {
      const lt = fieldTime(l, k), rt = fieldTime(r, k);
      const src = lt >= rt ? l : r, t = Math.max(lt, rt);
      // A field only one side has, from before the other side replaced the whole record, was removed there.
      if (!(k in src.d)) continue;
      if (!(k in (src === l ? r : l).d) && t < Math.max(lb, rb)) continue;
      d[k] = src.d[k];
      if (t > Math.max(lb, rb)) f[k] = t;
    }
    return { d, t: Math.max(l.t || 0, r.t || 0), b: Math.max(lb, rb), f };
  }
  /** Merges GitHub's copy into this device. Returns true if GitHub needs this device's changes. */
  function merge(remote) {
    let changedLocal = false, remoteMissing = false;
    remote = remote || {};
    for (const k of new Set([...Object.keys(records), ...Object.keys(remote)])) {
      const l = records[k], r = remote[k];
      const m = mergeRecord(l, r);
      clock = Math.max(clock, m.t || 0);
      if (!same(m, l)) { records[k] = m; changedLocal = true; }
      if (!same(m, r)) remoteMissing = true;
    }
    if (changedLocal) { persist(); notify(); }
    return remoteMissing;
  }
  async function syncNow() {
    if (!gh.ready()) { setStatus("local", "Saved on this device only. Add your GitHub token in My CV › App connections to sync."); return; }
    if (syncing) return syncing;
    syncing = (async () => {
      setStatus("syncing", "Syncing…");
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const file = await gh.readFile(SYNC_PATH);
          let remote = {};
          if (file) { try { remote = JSON.parse(file.text).records || {}; } catch (e) { remote = {}; } }
          syncSha = file ? file.sha : null;
          const needPush = merge(remote) || dirty;
          if (needPush) {
            syncSha = await gh.writeFile(SYNC_PATH, JSON.stringify({ app: "job-tracker", version: 1, records }), syncSha, "Update job tracker");
          }
          dirty = false;
          setStatus("synced", "Synced with your private GitHub repo");
          return;
        } catch (e) {
          if (e.code === "conflict" && attempt < 2) continue;
          setStatus("error", e.code === "bad_github_token" ? "GitHub token not accepted. Check it in My CV › App connections."
            : e.code === "github_forbidden" ? "Your GitHub token can't open the repo. It needs Contents: Read and write."
            : navigator.onLine === false ? "Offline. Changes are saved on this device and will sync later." : "Couldn't sync just now. Your changes are safe on this device.");
          return;
        }
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  function schedulePush() {
    dirty = true;
    if (!gh.ready()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, 3000);
  }
  // Pull from GitHub when the app opens, comes back to the front, regains focus or goes back online,
  // and every minute while it's on screen. Push straight away when it goes to the background.
  let lastPull = 0;
  function pullSoon() { if (Date.now() - lastPull < 2000) return; lastPull = Date.now(); syncNow(); }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pullSoon();
    else if (dirty && gh.ready()) { clearTimeout(pushTimer); syncNow(); }
  });
  window.addEventListener("focus", pullSoon);
  window.addEventListener("pageshow", pullSoon);
  window.addEventListener("online", () => syncNow());
  setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, 60000);

  /* ---------------- Set up another device ---------------- */
  // A setup code carries this device's connections (GitHub token, repo, AI key) so the other device needs no typing.
  const SETUP_PREFIX = "JOBAPP-SETUP-1:";
  function setupCode() {
    const s = settings();
    return SETUP_PREFIX + b64encode(JSON.stringify({ repo: s.repo, githubToken: s.githubToken, geminiKey: s.geminiKey, model: s.model }));
  }
  function applySetupCode(text) {
    // Notes, Mail and Messages can add line breaks or spaces; take them out.
    const m = String(text || "").replace(/\s+/g, "").match(/JOBAPP-SETUP-1:([A-Za-z0-9+/=_%-]+)/);
    if (!m) throw err("bad_setup_code", "That isn't a setup code. It should start with JOBAPP-SETUP-1:. Copy it again on your Mac.");
    let s;
    try { s = JSON.parse(b64decode(decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/"))); }
    catch (e) { throw err("bad_setup_code", "That setup code is damaged. Copy it again."); }
    const keep = {};
    for (const k of ["repo", "githubToken", "geminiKey", "model"]) if (typeof s[k] === "string" && s[k]) keep[k] = s[k];
    if (!keep.githubToken) throw err("bad_setup_code", "That setup code has no GitHub token");
    saveSettings(keep);
    return keep;
  }
  function setupLink() {
    const code = setupCode().slice(SETUP_PREFIX.length).replace(/\+/g, "-").replace(/\//g, "_");
    return location.origin + location.pathname + "#setup=" + code;
  }
  // Opening a setup link applies it once, then removes it from the address bar and history.
  let setupFromLink = null;
  if (/^#setup=/.test(location.hash)) {
    try { setupFromLink = applySetupCode(SETUP_PREFIX + location.hash.slice(7)); } catch (e) { setupFromLink = e; }
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }

  /* ---------------- AI writing through Gemini ---------------- */
  function toContents(input) {
    if (typeof input === "string") return [{ role: "user", parts: [{ text: input }] }];
    return input.map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: String(t.content) }] }));
  }
  /* Google retires model names over time. If ours is gone, ask Google which Flash models this key can use. */
  async function pickModel(key, avoid) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    if (!res.ok) return null;
    const names = ((await res.json()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .filter(n => /flash/.test(n) && !/lite|image|tts|audio|live|embed|preview|exp/.test(n));
    const pool = names.filter(n => n !== avoid);
    if (pool.includes("gemini-flash-latest")) return "gemini-flash-latest";
    const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    pool.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    return pool[0] || null;
  }

  async function gemini(input, opts = {}, json = false, retried = false) {
    const s = settings();
    if (!s.geminiKey) throw err("not_granted", "Add your free Gemini key in My CV › App connections");
    const body = {
      contents: toContents(input),
      generationConfig: { maxOutputTokens: 8192, temperature: json ? 0.2 : 0.6, ...(json ? { responseMimeType: "application/json" } : {}) },
    };
    const stream = !json && typeof opts.onText === "function";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model || DEFAULTS.model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    let res;
    try {
      res = await fetch(url, { method: "POST", signal: opts.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey }, body: JSON.stringify(body) });
    } catch (e) {
      if (e.name === "AbortError") throw err("cancelled");
      throw err("offline", "No connection");
    }
    const googleSays = async () => { try { return ((await res.clone().json()).error.message || "").slice(0, 300); } catch (e) { return ""; } };
    // 429 is a quota limit on this key, not a busy server. The free tier allows only a few requests a minute:
    // when Google says "retry in Ns", wait that long once. Otherwise (daily limit) try one other Flash model.
    if (res.status === 429) {
      let body = {}; try { body = await res.clone().json(); } catch (e) {}
      const msg = ((body.error && body.error.message) || "").slice(0, 300);
      const info = ((body.error && body.error.details) || []).find(d => /RetryInfo/.test(d["@type"] || ""));
      const m = (info && /([\d.]+)s/.exec(info.retryDelay || "")) || /retry in ([\d.]+)s/i.exec(msg);
      const wait = m ? Math.ceil(parseFloat(m[1])) : null;
      const daily = /per ?day|PerDay/i.test(msg);
      if (!daily && wait != null && wait <= 60 && !opts._waited && !(opts.signal && opts.signal.aborted)) {
        if (typeof opts.onWait === "function") opts.onWait(wait);
        await new Promise(r => setTimeout(r, (wait + 1) * 1000));
        return gemini(input, { ...opts, _waited: true }, json, retried);
      }
      if (!opts._quota) {
        const alt = await pickModel(s.geminiKey, s.model).catch(() => null);
        if (alt && alt !== s.model) {
          saveSettings({ model: alt }); window.dispatchEvent(new CustomEvent("jobapp-model", { detail: alt }));
          return gemini(input, { ...opts, _quota: true }, json, retried);
        }
      }
      const e = err("quota", msg); e.status = 429; e.daily = daily; throw e;
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const msg = await googleSays();
      const e = err(/api key|permission|denied/i.test(msg) || res.status !== 400 ? "not_granted" : "ai_" + res.status, msg); e.status = res.status; throw e;
    }
    // Google's free tier is sometimes overloaded: wait and try again, then try another Flash model.
    if ((res.status === 503 || res.status === 500) && (opts._busy || 0) < 3 && !(opts.signal && opts.signal.aborted)) {
      const n = (opts._busy || 0) + 1;
      if (n === 3) {
        const alt = await pickModel(s.geminiKey, s.model).catch(() => null);
        if (alt) { saveSettings({ model: alt }); window.dispatchEvent(new CustomEvent("jobapp-model", { detail: alt })); }
      }
      await new Promise(r => setTimeout(r, 1500 * n));
      return gemini(input, { ...opts, _busy: n }, json, retried);
    }
    if (res.status === 503 || res.status === 500) { const e = err("rate_limited", await googleSays()); e.status = res.status; throw e; }
    if (res.status === 404 && !retried) {
      const model = await pickModel(s.geminiKey).catch(() => null);
      if (model && model !== s.model) {
        saveSettings({ model });
        window.dispatchEvent(new CustomEvent("jobapp-model", { detail: model }));
        return gemini(input, opts, json, true);
      }
    }
    if (!res.ok) { const e = err("ai_" + res.status, await googleSays()); e.status = res.status; throw e; }
    let text = "", finish = "";
    const take = chunk => {
      const c = chunk && chunk.candidates && chunk.candidates[0];
      if (!c) return;
      if (c.finishReason) finish = c.finishReason;
      for (const p of (c.content && c.content.parts) || []) if (p.text && !p.thought) text += p.text;
    };
    if (stream) {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.startsWith("data:")) { try { take(JSON.parse(line.slice(5))); opts.onText({ text }); } catch (e) {} }
          }
        }
      } catch (e) { if (e.name === "AbortError") throw err("cancelled"); throw err("interrupted"); }
    } else {
      take(await res.json());
    }
    if (finish === "SAFETY") throw err("blocked", "The AI declined this request");
    return { text, truncated: finish === "MAX_TOKENS" };
  }
  const sample = (input, opts) => gemini(input, opts, false);
  sample.json = async (input, opts) => {
    const { text } = await gemini(input, opts, true);
    const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(clean); } catch (e) { throw err("bad_json", "The AI reply wasn't valid JSON"); }
  };

  /* ---------------- Downloads ---------------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      // On iPhone the share sheet is the friendliest way to save to Files or send by email.
      if (navigator.canShare && /iPhone|iPad/.test(navigator.userAgent) && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (e) { if (e.name === "AbortError") throw err("declined"); }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };

  // The Claude-only connector API isn't available here; the app overrides the features that used it.
  const mcp = { standalone: true, async callTool() { throw err("server_not_connected"); } };

  const services = { db, sample, downloads, mcp };
  window.claude = { use: name => Promise.resolve(services[name] || null) };
  window.jobapp = { settings, saveSettings, syncNow, syncState, gh, db, sample, b64decode,
                    setupCode, setupLink, applySetupCode, setupFromLink, _merge: mergeRecord };
  if (gh.ready()) queueMicrotask(syncNow); else setStatus("local", syncState.message);
})();
