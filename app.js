"use strict";

/* ---------- Config ---------- */

const SUPABASE_URL = "https://pphyqzsngumlqqznynvi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_4OiwGIFW5NumANvYdHQKyg_PGDQ1pl4";

const STORAGE_KEY = "korean-sentences-v1";
const SETTINGS_KEY = "korean-settings-v1";
const GROUPS_KEY = "korean-groups-v1";
const MIGRATION_KEY = "korean-migrated-v2";

const DEFAULT_SETTINGS = {
  englishReps: 1,
  koreanReps: 2,
  order: "en-first",       // "en-first" | "ko-first"
  speed: 1.0,
  repGapSec: 0.5,
  sentenceGapSec: 1.5,
  loop: false,
  shuffle: false,
  voiceURI: null,
  selectedGroupId: null,   // null = "All"
};

const state = {
  sentences: [],
  groups: [],
  settings: { ...DEFAULT_SETTINGS },
  search: "",
  editingId: null,
  pendingImport: null,     // { sentences: [...], groupColumnPresent: bool }
  user: null,              // current Supabase user (or null)
  player: {
    queue: [],
    index: 0,
    playing: false,
    wakeLock: null,
    abortTimer: null,
    sessionGroupId: null,
  },
};

/* ---------- Supabase client ---------- */

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/* ---------- IDs ---------- */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Fallback v4
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = Array.from(a, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10,16).join("")}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === "string" && UUID_RE.test(s);

/* ---------- Remote (Supabase) helpers ---------- */

const syncIndicatorEl = document.getElementById("sync-indicator");

function showSync(text, isError = false) {
  if (!syncIndicatorEl) return;
  syncIndicatorEl.hidden = !text;
  syncIndicatorEl.textContent = text || "";
  syncIndicatorEl.classList.toggle("error", !!isError);
}

function rowToSentence(r) {
  return {
    id: r.id,
    english: r.english,
    korean: r.korean,
    groupIds: r.group_ids || [],
    audioPath: r.audio_path || null,
    audioVoice: r.audio_voice || null,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  };
}

function rowToGroup(r) {
  return {
    id: r.id,
    name: r.name,
    playCount: r.play_count || 0,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  };
}

function sentenceToRow(s) {
  return {
    id: s.id,
    user_id: state.user?.id,
    english: s.english,
    korean: s.korean,
    group_ids: s.groupIds || [],
  };
}

function groupToRow(g) {
  return {
    id: g.id,
    user_id: state.user?.id,
    name: g.name,
    play_count: g.playCount || 0,
  };
}

async function remoteSyncAll() {
  if (!state.user) return;
  showSync("Syncing…");
  try {
    const [sentencesRes, groupsRes] = await Promise.all([
      sb.from("sentences").select("*").order("created_at", { ascending: false }),
      sb.from("groups").select("*").order("name"),
    ]);
    if (sentencesRes.error) throw sentencesRes.error;
    if (groupsRes.error) throw groupsRes.error;
    state.sentences = sentencesRes.data.map(rowToSentence);
    state.groups = groupsRes.data.map(rowToGroup);
    saveSentences();
    saveGroups();
    showSync("");
  } catch (err) {
    console.error("sync error", err);
    showSync(navigator.onLine ? "Sync error" : "Offline", true);
  }
}

function remoteUpsertSentence(s) {
  if (!state.user) return;
  sb.from("sentences").upsert(sentenceToRow(s)).then(({ error }) => {
    if (error) {
      console.error("upsert sentence", error);
      showSync("Save failed", true);
    }
  });
}

function remoteDeleteSentence(id) {
  if (!state.user) return;
  sb.from("sentences").delete().eq("id", id).then(({ error }) => {
    if (error) console.error("delete sentence", error);
  });
}

function remoteUpsertGroup(g) {
  if (!state.user) return;
  sb.from("groups").upsert(groupToRow(g)).then(({ error }) => {
    if (error) console.error("upsert group", error);
  });
}

function remoteDeleteGroup(id) {
  if (!state.user) return;
  sb.from("groups").delete().eq("id", id).then(({ error }) => {
    if (error) console.error("delete group", error);
  });
}

function remoteIncrementGroupPlay(id) {
  if (!state.user) return;
  sb.rpc("increment_group_play_count", { g: id }).then(({ error }) => {
    if (error) console.error("increment play", error);
  });
}

async function remoteBulkInsert(sentences, groups) {
  if (!state.user) return;
  if (groups.length) {
    const { error } = await sb.from("groups").upsert(groups.map(groupToRow));
    if (error) throw error;
  }
  if (sentences.length) {
    const { error } = await sb.from("sentences").upsert(sentences.map(sentenceToRow));
    if (error) throw error;
  }
}

/* ---------- Audio generation + storage ---------- */

const DEFAULT_GOOGLE_VOICE = "ko-KR-Neural2-A";

// In-memory signed URL cache so we don't re-sign on every play.
const signedUrlCache = new Map(); // path -> { url, expiresAt }

async function getSignedAudioUrl(path) {
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
  const { data, error } = await sb.storage.from("audio").createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) {
    console.error("signed url", error);
    return null;
  }
  signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + 3600 * 1000,
  });
  return data.signedUrl;
}

// Track in-flight generations so we don't double-fire for the same sentence.
const audioGenInFlight = new Set();

async function generateAudioFor(sentence) {
  if (!state.user || !sentence?.id || !sentence.korean) return;
  if (audioGenInFlight.has(sentence.id)) return;
  if (!navigator.onLine) return;

  audioGenInFlight.add(sentence.id);
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const voice = state.settings.googleVoice || DEFAULT_GOOGLE_VOICE;

    const ttsRes = await fetch("/api/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ text: sentence.korean, voice }),
    });
    if (!ttsRes.ok) {
      const err = await ttsRes.text().catch(() => "");
      console.error("tts failed", ttsRes.status, err);
      return;
    }
    const blob = await ttsRes.blob();
    const path = `${state.user.id}/${sentence.id}.mp3`;
    const upRes = await sb.storage.from("audio").upload(path, blob, {
      upsert: true,
      contentType: "audio/mpeg",
    });
    if (upRes.error) {
      console.error("storage upload", upRes.error);
      return;
    }
    sentence.audioPath = path;
    sentence.audioVoice = voice;

    const { error: updErr } = await sb
      .from("sentences")
      .update({ audio_path: path, audio_voice: voice })
      .eq("id", sentence.id);
    if (updErr) console.error("audio_path update", updErr);

    saveSentences();
    // If the player is showing this sentence, refresh its display.
    if (
      state.player.queue[state.player.index]?.id === sentence.id &&
      document.getElementById("view-play").classList.contains("active")
    ) {
      // Pre-warm the signed URL so first play is instant.
      getSignedAudioUrl(path);
    }
  } catch (err) {
    console.error("audio gen error", err);
  } finally {
    audioGenInFlight.delete(sentence.id);
  }
}

/* ---------- One-time migration of pre-Supabase local data ---------- */

async function migrateLocalIfNeeded() {
  if (!state.user) return;
  if (localStorage.getItem(MIGRATION_KEY)) return;

  const hasLocal = state.sentences.length || state.groups.length;
  if (!hasLocal) {
    localStorage.setItem(MIGRATION_KEY, "1");
    return;
  }

  showSync("Uploading existing data…");

  // Map any non-UUID group IDs to fresh UUIDs and rewrite references.
  const idMap = new Map();
  for (const g of state.groups) {
    if (!isUUID(g.id)) idMap.set(g.id, uid());
  }
  const newGroups = state.groups.map((g) => ({
    ...g,
    id: idMap.get(g.id) || g.id,
  }));
  const newSentences = state.sentences.map((s) => ({
    ...s,
    id: isUUID(s.id) ? s.id : uid(),
    groupIds: (s.groupIds || []).map((gid) => idMap.get(gid) || gid),
  }));

  try {
    await remoteBulkInsert(newSentences, newGroups);
    state.sentences = newSentences;
    state.groups = newGroups;
    saveSentences();
    saveGroups();
    localStorage.setItem(MIGRATION_KEY, "1");
    showSync("");
  } catch (err) {
    console.error("migration error", err);
    showSync("Migration failed", true);
  }
}

/* ---------- Persistence + migration (local cache) ---------- */

function loadAll() {
  // Sentences
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.sentences = raw ? JSON.parse(raw) : [];
  } catch {
    state.sentences = [];
  }
  // Groups
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    state.groups = raw ? JSON.parse(raw) : [];
  } catch {
    state.groups = [];
  }
  // Settings
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    state.settings = { ...DEFAULT_SETTINGS, ...stored };
    // Migrate legacy `mode` field
    if (stored.mode && stored.englishReps === undefined) {
      const map = {
        "ko":    { englishReps: 0, koreanReps: 1, order: "en-first" },
        "en-ko": { englishReps: 1, koreanReps: 1, order: "en-first" },
        "ko-en": { englishReps: 1, koreanReps: 1, order: "ko-first" },
        "ko-ko": { englishReps: 0, koreanReps: 2, order: "en-first" },
      };
      Object.assign(state.settings, map[stored.mode] || {});
    }
    if (stored.pauseSec !== undefined && stored.sentenceGapSec === undefined) {
      state.settings.sentenceGapSec = stored.pauseSec;
    }
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }
  // Migrate sentences: ensure groupIds exists
  let migrated = false;
  for (const s of state.sentences) {
    if (!Array.isArray(s.groupIds)) {
      s.groupIds = [];
      migrated = true;
    }
  }
  if (migrated) saveSentences();
}

function saveSentences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sentences));
}
function saveGroups() {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(state.groups));
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

/* ---------- Groups CRUD ---------- */

function findGroupByName(name) {
  const lower = name.trim().toLowerCase();
  return state.groups.find((g) => g.name.toLowerCase() === lower);
}

function getOrCreateGroup(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = findGroupByName(trimmed);
  if (existing) return existing;
  const g = { id: uid(), name: trimmed, createdAt: Date.now(), playCount: 0 };
  state.groups.push(g);
  saveGroups();
  remoteUpsertGroup(g);
  return g;
}

function deleteGroup(id) {
  state.groups = state.groups.filter((g) => g.id !== id);
  const affected = [];
  for (const s of state.sentences) {
    if ((s.groupIds || []).includes(id)) {
      s.groupIds = s.groupIds.filter((gid) => gid !== id);
      affected.push(s);
    }
  }
  if (state.settings.selectedGroupId === id) {
    state.settings.selectedGroupId = null;
    saveSettings();
  }
  saveGroups();
  saveSentences();
  remoteDeleteGroup(id);
  for (const s of affected) remoteUpsertSentence(s);
}

function renameGroup(id, newName) {
  const trimmed = newName.trim();
  if (!trimmed) return;
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  g.name = trimmed;
  saveGroups();
  remoteUpsertGroup(g);
}

function sentencesInGroup(groupId) {
  if (!groupId) return state.sentences;
  return state.sentences.filter((s) => (s.groupIds || []).includes(groupId));
}

/* ---------- View switching ---------- */

const views = document.querySelectorAll(".view");
const tabs = document.querySelectorAll(".tab");

function showView(name) {
  views.forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "list") {
    renderGroupChips();
    renderList();
  }
  if (name === "add") renderGroupCheckboxes();
  if (name === "play") preparePlayer();
  if (name === "settings") {
    populateVoiceSelect();
    renderGroupsManagement();
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});

/* ---------- List view: group chips + sentences ---------- */

const chipsRow = document.getElementById("group-chips");
const listEl = document.getElementById("sentence-list");
const emptyEl = document.getElementById("empty-state");
const countEl = document.getElementById("count");
const searchEl = document.getElementById("search");

searchEl.addEventListener("input", (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderList();
});

function renderGroupChips() {
  chipsRow.innerHTML = "";
  const allChip = document.createElement("button");
  allChip.className = "chip" + (state.settings.selectedGroupId === null ? " active" : "");
  allChip.innerHTML = `All <span class="chip-count">${state.sentences.length}</span>`;
  allChip.addEventListener("click", () => selectGroup(null));
  chipsRow.appendChild(allChip);

  for (const g of state.groups) {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.settings.selectedGroupId === g.id ? " active" : "");
    const count = sentencesInGroup(g.id).length;
    chip.innerHTML = `${escapeHTML(g.name)} <span class="chip-count">${count}</span>`;
    chip.addEventListener("click", () => selectGroup(g.id));
    chipsRow.appendChild(chip);
  }
}

function selectGroup(id) {
  state.settings.selectedGroupId = id;
  saveSettings();
  renderGroupChips();
  renderList();
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function filteredSentences() {
  let items = sentencesInGroup(state.settings.selectedGroupId);
  if (state.search) {
    items = items.filter(
      (s) =>
        s.english.toLowerCase().includes(state.search) ||
        s.korean.toLowerCase().includes(state.search)
    );
  }
  return items;
}

function groupNamesFor(s) {
  return (s.groupIds || [])
    .map((id) => state.groups.find((g) => g.id === id))
    .filter(Boolean)
    .map((g) => g.name);
}

function renderList() {
  const items = filteredSentences();
  countEl.textContent = items.length;
  listEl.innerHTML = "";
  emptyEl.hidden = state.sentences.length !== 0;

  for (const s of items) {
    const li = document.createElement("li");
    li.className = "sentence";
    const tags = groupNamesFor(s);
    li.innerHTML = `
      <div class="lines">
        <div class="en"></div>
        <div class="ko" lang="ko"></div>
        ${tags.length ? `<div class="group-tags">${tags.map(t => `<span class="group-tag">${escapeHTML(t)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="sentence-actions">
        <button class="icon-btn" data-action="speak" title="Play Korean">▶</button>
        <button class="icon-btn" data-action="edit" title="Edit">✎</button>
        <button class="icon-btn" data-action="delete" title="Delete">🗑</button>
      </div>
    `;
    li.querySelector(".en").textContent = s.english;
    li.querySelector(".ko").textContent = s.korean;
    li.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => handleSentenceAction(s.id, btn.dataset.action));
    });
    listEl.appendChild(li);
  }
}

function handleSentenceAction(id, action) {
  const s = state.sentences.find((x) => x.id === id);
  if (!s) return;
  if (action === "speak") {
    cancelSpeech();
    playKorean(s);
  } else if (action === "edit") {
    startEdit(s);
  } else if (action === "delete") {
    if (confirm("Delete this sentence?")) {
      state.sentences = state.sentences.filter((x) => x.id !== id);
      saveSentences();
      remoteDeleteSentence(id);
      renderGroupChips();
      renderList();
    }
  }
}

/* ---------- Add / edit view ---------- */

const addForm = document.getElementById("add-form");
const enInput = document.getElementById("input-english");
const koInput = document.getElementById("input-korean");
const previewBtn = document.getElementById("preview-korean");
const editBanner = document.getElementById("edit-banner");
const cancelEditBtn = document.getElementById("cancel-edit");
const groupCheckboxesEl = document.getElementById("group-checkboxes");

let formGroupSelection = new Set(); // ids selected in the form

function renderGroupCheckboxes() {
  groupCheckboxesEl.innerHTML = "";
  for (const g of state.groups) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-check" + (formGroupSelection.has(g.id) ? " checked" : "");
    btn.textContent = g.name;
    btn.addEventListener("click", () => {
      if (formGroupSelection.has(g.id)) formGroupSelection.delete(g.id);
      else formGroupSelection.add(g.id);
      renderGroupCheckboxes();
    });
    groupCheckboxesEl.appendChild(btn);
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "group-check new-btn";
  newBtn.textContent = "+ New group";
  newBtn.addEventListener("click", () => {
    const name = prompt("Group name?");
    if (!name) return;
    const g = getOrCreateGroup(name);
    if (g) {
      formGroupSelection.add(g.id);
      renderGroupCheckboxes();
    }
  });
  groupCheckboxesEl.appendChild(newBtn);
}

function resetAddForm() {
  state.editingId = null;
  enInput.value = "";
  koInput.value = "";
  formGroupSelection = new Set();
  if (state.settings.selectedGroupId) {
    formGroupSelection.add(state.settings.selectedGroupId);
  }
  editBanner.hidden = true;
}

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const english = enInput.value.trim();
  const korean = koInput.value.trim();
  if (!english || !korean) return;
  const groupIds = [...formGroupSelection];

  let touched = null;
  if (state.editingId) {
    const s = state.sentences.find((x) => x.id === state.editingId);
    if (s) {
      s.english = english;
      s.korean = korean;
      s.groupIds = groupIds;
      // Editing the text invalidates any cached audio.
      s.audioPath = null;
      s.audioVoice = null;
      touched = s;
    }
  } else {
    touched = {
      id: uid(),
      english,
      korean,
      groupIds,
      audioPath: null,
      audioVoice: null,
      createdAt: Date.now(),
    };
    state.sentences.unshift(touched);
  }
  saveSentences();
  if (touched) {
    remoteUpsertSentence(touched);
    generateAudioFor(touched);
  }
  resetAddForm();
  renderGroupChips();
  renderList();
  showView("list");
});

previewBtn.addEventListener("click", () => {
  const text = koInput.value.trim();
  if (text) {
    cancelSpeech();
    playKorean(text);
  }
});

cancelEditBtn.addEventListener("click", () => {
  resetAddForm();
  showView("list");
});

function startEdit(s) {
  state.editingId = s.id;
  enInput.value = s.english;
  koInput.value = s.korean;
  formGroupSelection = new Set(s.groupIds || []);
  editBanner.hidden = false;
  renderGroupCheckboxes();
  showView("add");
}

// When opening Add fresh (not editing), pre-select current filter group
document.querySelector('[data-view="add"]').addEventListener("click", () => {
  if (!state.editingId) {
    formGroupSelection = new Set();
    if (state.settings.selectedGroupId) {
      formGroupSelection.add(state.settings.selectedGroupId);
    }
  }
});

/* ---------- Speech synthesis ---------- */

let voicesCache = [];

function loadVoices() {
  voicesCache = window.speechSynthesis.getVoices();
}

if (typeof speechSynthesis !== "undefined") {
  loadVoices();
  speechSynthesis.onvoiceschanged = () => {
    loadVoices();
    populateVoiceSelect();
  };
}

function pickKoreanVoice() {
  if (state.settings.voiceURI) {
    const v = voicesCache.find((vv) => vv.voiceURI === state.settings.voiceURI);
    if (v) return v;
  }
  return (
    voicesCache.find((v) => /ko[-_]?KR/i.test(v.lang)) ||
    voicesCache.find((v) => v.lang && v.lang.toLowerCase().startsWith("ko")) ||
    null
  );
}

function pickEnglishVoice() {
  return (
    voicesCache.find((v) => /en[-_]?US/i.test(v.lang)) ||
    voicesCache.find((v) => v.lang && v.lang.toLowerCase().startsWith("en")) ||
    null
  );
}

function speak(text, lang, { rate = 1.0 } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    const voice = lang.startsWith("ko") ? pickKoreanVoice() : pickEnglishVoice();
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

const playerAudioEl = document.getElementById("player-audio");

function playAudioUrl(url) {
  return new Promise((resolve) => {
    const onEnd = () => { cleanup(); resolve(); };
    const onError = (e) => { cleanup(); console.warn("audio error", e); resolve(); };
    function cleanup() {
      playerAudioEl.removeEventListener("ended", onEnd);
      playerAudioEl.removeEventListener("error", onError);
    }
    playerAudioEl.addEventListener("ended", onEnd);
    playerAudioEl.addEventListener("error", onError);
    playerAudioEl.src = url;
    try { playerAudioEl.playbackRate = state.settings.speed; } catch {}
    const p = playerAudioEl.play();
    if (p && typeof p.catch === "function") p.catch(onError);
  });
}

function stopAudio() {
  try {
    playerAudioEl.pause();
    playerAudioEl.removeAttribute("src");
    playerAudioEl.load();
  } catch {}
}

// Speak Korean: prefer cached MP3, fall back to on-device TTS.
// Accepts either a sentence object or a raw string (for the textarea preview).
async function playKorean(sentenceOrText) {
  if (typeof sentenceOrText === "string") {
    return speak(sentenceOrText, "ko-KR", { rate: state.settings.speed });
  }
  const s = sentenceOrText;
  if (s.audioPath) {
    const url = await getSignedAudioUrl(s.audioPath);
    if (url) return playAudioUrl(url);
  } else if (state.user && navigator.onLine) {
    // Lazy backfill: kick off generation for next time.
    generateAudioFor(s);
  }
  return speak(s.korean, "ko-KR", { rate: state.settings.speed });
}

function speakEnglish(text) {
  return speak(text, "en-US", { rate: state.settings.speed });
}

function cancelSpeech() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  stopAudio();
}

/* ---------- Player ---------- */

const playerEn = document.getElementById("player-en");
const playerKo = document.getElementById("player-ko");
const playerProgress = document.getElementById("player-progress");
const btnPlayPause = document.getElementById("btn-playpause");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");

const playerGroupSelect = document.getElementById("player-group");
const playerPlayCount = document.getElementById("player-playcount");

const englishRepsInput = document.getElementById("english-reps");
const koreanRepsInput = document.getElementById("korean-reps");
const playOrderSelect = document.getElementById("play-order");
const speedSlider = document.getElementById("speed");
const speedLabel = document.getElementById("speed-label");
const repGapSlider = document.getElementById("rep-gap");
const repGapLabel = document.getElementById("rep-gap-label");
const sentenceGapSlider = document.getElementById("sentence-gap");
const sentenceGapLabel = document.getElementById("sentence-gap-label");
const loopChk = document.getElementById("loop");
const shuffleChk = document.getElementById("shuffle");

function applySettingsToControls() {
  englishRepsInput.value = state.settings.englishReps;
  koreanRepsInput.value = state.settings.koreanReps;
  playOrderSelect.value = state.settings.order;
  speedSlider.value = state.settings.speed;
  speedLabel.textContent = `${(+state.settings.speed).toFixed(2)}x`;
  repGapSlider.value = state.settings.repGapSec;
  repGapLabel.textContent = `${(+state.settings.repGapSec).toFixed(2)}s`;
  sentenceGapSlider.value = state.settings.sentenceGapSec;
  sentenceGapLabel.textContent = `${(+state.settings.sentenceGapSec).toFixed(2)}s`;
  loopChk.checked = state.settings.loop;
  shuffleChk.checked = state.settings.shuffle;
}

englishRepsInput.addEventListener("change", () => {
  state.settings.englishReps = Math.max(0, parseInt(englishRepsInput.value) || 0);
  englishRepsInput.value = state.settings.englishReps;
  saveSettings();
});
koreanRepsInput.addEventListener("change", () => {
  state.settings.koreanReps = Math.max(1, parseInt(koreanRepsInput.value) || 1);
  koreanRepsInput.value = state.settings.koreanReps;
  saveSettings();
});
playOrderSelect.addEventListener("change", () => {
  state.settings.order = playOrderSelect.value;
  saveSettings();
});
speedSlider.addEventListener("input", () => {
  state.settings.speed = parseFloat(speedSlider.value);
  speedLabel.textContent = `${state.settings.speed.toFixed(2)}x`;
  saveSettings();
});
repGapSlider.addEventListener("input", () => {
  state.settings.repGapSec = parseFloat(repGapSlider.value);
  repGapLabel.textContent = `${state.settings.repGapSec.toFixed(2)}s`;
  saveSettings();
});
sentenceGapSlider.addEventListener("input", () => {
  state.settings.sentenceGapSec = parseFloat(sentenceGapSlider.value);
  sentenceGapLabel.textContent = `${state.settings.sentenceGapSec.toFixed(2)}s`;
  saveSettings();
});
loopChk.addEventListener("change", () => {
  state.settings.loop = loopChk.checked;
  saveSettings();
});
shuffleChk.addEventListener("change", () => {
  state.settings.shuffle = shuffleChk.checked;
  saveSettings();
  if (state.player.queue.length) {
    rebuildQueue(true);
    renderPlayerCurrent();
  }
});

playerGroupSelect.addEventListener("change", () => {
  const val = playerGroupSelect.value;
  state.settings.selectedGroupId = val === "" ? null : val;
  saveSettings();
  // Stop any in-progress playback because the queue changes
  if (state.player.playing) stopPlayback();
  rebuildQueue();
  renderPlayerCurrent();
  renderPlayerPlayCount();
});

function populatePlayerGroupSelect() {
  playerGroupSelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = `All sentences (${state.sentences.length})`;
  playerGroupSelect.appendChild(allOpt);
  for (const g of state.groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    const count = sentencesInGroup(g.id).length;
    opt.textContent = `${g.name} (${count})`;
    playerGroupSelect.appendChild(opt);
  }
  playerGroupSelect.value = state.settings.selectedGroupId || "";
}

function renderPlayerPlayCount() {
  const id = state.settings.selectedGroupId;
  if (!id) {
    playerPlayCount.textContent = "";
    return;
  }
  const g = state.groups.find((x) => x.id === id);
  if (!g) {
    playerPlayCount.textContent = "";
    return;
  }
  const n = g.playCount || 0;
  playerPlayCount.textContent = n === 1 ? "Played 1 time" : `Played ${n} times`;
}

function rebuildQueue(preserveCurrent = false) {
  const current = preserveCurrent ? state.player.queue[state.player.index] : null;
  let q = sentencesInGroup(state.settings.selectedGroupId).slice();
  if (state.settings.shuffle) {
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
  }
  state.player.queue = q;
  if (current) {
    const idx = q.findIndex((s) => s.id === current.id);
    state.player.index = idx >= 0 ? idx : 0;
  } else {
    state.player.index = 0;
  }
  state.player.sessionGroupId = state.settings.selectedGroupId;
}

function preparePlayer() {
  rebuildQueue();
  applySettingsToControls();
  populatePlayerGroupSelect();
  renderPlayerCurrent();
  renderPlayerPlayCount();
}

function renderPlayerCurrent() {
  const s = state.player.queue[state.player.index];
  if (!s) {
    playerEn.textContent = "—";
    playerKo.textContent = state.sentences.length
      ? "No sentences in this group."
      : "Add some sentences first.";
    playerProgress.textContent = "0 / 0";
    return;
  }
  playerEn.textContent = s.english;
  playerKo.textContent = s.korean;
  playerProgress.textContent = `${state.player.index + 1} / ${state.player.queue.length}`;
  if (state.player.playing && typeof updateMediaSessionMetadata === "function") {
    updateMediaSessionMetadata();
  }
}

function setSpeakingHighlight(which) {
  playerEn.classList.toggle("speaking", which === "en");
  playerKo.classList.toggle("speaking", which === "ko");
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !state.player.wakeLock) {
      state.player.wakeLock = await navigator.wakeLock.request("screen");
      state.player.wakeLock.addEventListener("release", () => {
        state.player.wakeLock = null;
      });
    }
  } catch {
    /* ignore */
  }
}

function releaseWakeLock() {
  if (state.player.wakeLock) {
    state.player.wakeLock.release().catch(() => {});
    state.player.wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.player.playing) {
    requestWakeLock();
  }
});

function sleep(ms) {
  return new Promise((resolve) => {
    state.player.abortTimer = setTimeout(() => {
      state.player.abortTimer = null;
      resolve();
    }, ms);
  });
}

function abortSleep() {
  if (state.player.abortTimer) {
    clearTimeout(state.player.abortTimer);
    state.player.abortTimer = null;
  }
}

function buildSegmentsFor(s) {
  const en = Array.from({ length: state.settings.englishReps }, () => ({ lang: "en", text: s.english }));
  const ko = Array.from({ length: state.settings.koreanReps }, () => ({ lang: "ko", text: s.korean }));
  return state.settings.order === "ko-first" ? [...ko, ...en] : [...en, ...ko];
}

async function playSentenceSegments(s) {
  const segments = buildSegmentsFor(s);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!state.player.playing) return;
    setSpeakingHighlight(seg.lang);
    if (seg.lang === "ko") await playKorean(s);
    else await speakEnglish(seg.text);
    setSpeakingHighlight(null);
    if (!state.player.playing) return;
    const isLast = i === segments.length - 1;
    if (!isLast && state.settings.repGapSec > 0) {
      await sleep(state.settings.repGapSec * 1000);
    }
  }
}

function incrementPlayCount() {
  const id = state.player.sessionGroupId;
  if (!id) return;
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  g.playCount = (g.playCount || 0) + 1;
  saveGroups();
  remoteIncrementGroupPlay(id);
  renderPlayerPlayCount();
  renderGroupsManagement();
}

async function playLoop() {
  while (state.player.playing) {
    if (!state.player.queue.length) {
      stopPlayback();
      return;
    }
    const s = state.player.queue[state.player.index];
    if (!s) {
      stopPlayback();
      return;
    }
    renderPlayerCurrent();
    await playSentenceSegments(s);
    if (!state.player.playing) return;

    const isLast = state.player.index >= state.player.queue.length - 1;
    if (!isLast && state.settings.sentenceGapSec > 0) {
      await sleep(state.settings.sentenceGapSec * 1000);
    }
    if (!state.player.playing) return;

    state.player.index += 1;
    if (state.player.index >= state.player.queue.length) {
      // Completed a full pass.
      incrementPlayCount();
      if (state.settings.loop) {
        if (state.settings.shuffle) rebuildQueue();
        state.player.index = 0;
        if (state.settings.sentenceGapSec > 0) {
          await sleep(state.settings.sentenceGapSec * 1000);
        }
      } else {
        stopPlayback();
        return;
      }
    }
  }
}

function startPlayback() {
  if (!state.player.queue.length) rebuildQueue();
  if (!state.player.queue.length) return;
  state.player.sessionGroupId = state.settings.selectedGroupId;
  state.player.playing = true;
  btnPlayPause.textContent = "⏸";
  requestWakeLock();
  setupMediaSession();
  updateMediaSessionMetadata();
  playLoop();
}

function stopPlayback() {
  state.player.playing = false;
  cancelSpeech();
  abortSleep();
  setSpeakingHighlight(null);
  btnPlayPause.textContent = "▶";
  releaseWakeLock();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "paused";
  }
}

btnPlayPause.addEventListener("click", () => {
  if (state.player.playing) stopPlayback();
  else startPlayback();
});

function gotoPrev() {
  cancelSpeech();
  abortSleep();
  state.player.index = Math.max(0, state.player.index - 1);
  renderPlayerCurrent();
  updateMediaSessionMetadata();
}

function gotoNext() {
  cancelSpeech();
  abortSleep();
  state.player.index = Math.min(state.player.queue.length - 1, state.player.index + 1);
  renderPlayerCurrent();
  updateMediaSessionMetadata();
}

btnPrev.addEventListener("click", gotoPrev);
btnNext.addEventListener("click", gotoNext);

/* ---------- Media Session API (lock screen / CarPlay controls) ---------- */

let mediaSessionWired = false;

function setupMediaSession() {
  if (!("mediaSession" in navigator) || mediaSessionWired) return;
  navigator.mediaSession.setActionHandler("play", () => {
    if (!state.player.playing) startPlayback();
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (state.player.playing) stopPlayback();
  });
  navigator.mediaSession.setActionHandler("previoustrack", gotoPrev);
  navigator.mediaSession.setActionHandler("nexttrack", gotoNext);
  mediaSessionWired = true;
}

function updateMediaSessionMetadata() {
  if (!("mediaSession" in navigator)) return;
  const s = state.player.queue[state.player.index];
  if (!s) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const groupName = state.player.sessionGroupId
    ? (state.groups.find((g) => g.id === state.player.sessionGroupId)?.name || "")
    : "All sentences";
  navigator.mediaSession.metadata = new MediaMetadata({
    title: s.korean,
    artist: s.english,
    album: groupName,
  });
  navigator.mediaSession.playbackState = state.player.playing ? "playing" : "paused";
}

/* ---------- Settings: voice ---------- */

const voiceSelect = document.getElementById("voice-select");
const voiceHint = document.getElementById("voice-hint");

function populateVoiceSelect() {
  if (!voiceSelect) return;
  const koreanVoices = voicesCache.filter(
    (v) => v.lang && v.lang.toLowerCase().startsWith("ko")
  );
  voiceSelect.innerHTML = "";
  if (!koreanVoices.length) {
    const opt = document.createElement("option");
    opt.textContent = "(no Korean voice installed)";
    voiceSelect.appendChild(opt);
    voiceSelect.disabled = true;
    voiceHint.textContent =
      "Install a Korean voice in your OS settings (iOS: Settings → Accessibility → Spoken Content → Voices → Korean).";
    return;
  }
  voiceSelect.disabled = false;
  voiceHint.textContent = "";
  for (const v of koreanVoices) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === state.settings.voiceURI) opt.selected = true;
    voiceSelect.appendChild(opt);
  }
}

voiceSelect.addEventListener("change", () => {
  state.settings.voiceURI = voiceSelect.value;
  saveSettings();
});

/* ---------- Settings: groups management ---------- */

const groupsListEl = document.getElementById("groups-list");
const newGroupBtn = document.getElementById("new-group-btn");

function renderGroupsManagement() {
  groupsListEl.innerHTML = "";
  if (!state.groups.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No groups yet.";
    groupsListEl.appendChild(p);
    return;
  }
  for (const g of state.groups) {
    const count = sentencesInGroup(g.id).length;
    const plays = g.playCount || 0;
    const row = document.createElement("div");
    row.className = "group-row";
    row.innerHTML = `
      <div>
        <div class="group-name"></div>
        <div class="group-meta">${count} sentence${count === 1 ? "" : "s"} · played ${plays}×</div>
      </div>
      <button class="icon-btn" data-act="rename" title="Rename">✎</button>
      <button class="icon-btn" data-act="delete" title="Delete">🗑</button>
    `;
    row.querySelector(".group-name").textContent = g.name;
    row.querySelector('[data-act="rename"]').addEventListener("click", () => {
      const name = prompt("Rename group:", g.name);
      if (name) {
        renameGroup(g.id, name);
        renderGroupsManagement();
        renderGroupChips();
        if (document.getElementById("view-play").classList.contains("active")) {
          populatePlayerGroupSelect();
        }
      }
    });
    row.querySelector('[data-act="delete"]').addEventListener("click", () => {
      if (confirm(`Delete group "${g.name}"? Sentences will not be deleted.`)) {
        deleteGroup(g.id);
        renderGroupsManagement();
        renderGroupChips();
        renderList();
      }
    });
    groupsListEl.appendChild(row);
  }
}

newGroupBtn.addEventListener("click", () => {
  const name = prompt("Group name?");
  if (!name) return;
  if (findGroupByName(name)) {
    alert("A group with that name already exists.");
    return;
  }
  getOrCreateGroup(name);
  renderGroupsManagement();
  renderGroupChips();
});

/* ---------- Settings: import / export ---------- */

document.getElementById("export-btn").addEventListener("click", () => {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    groups: state.groups,
    sentences: state.sentences,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `korean-sentences-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const importPreviewEl = document.getElementById("import-preview");
const importSummaryEl = document.getElementById("import-summary");
const importGroupSelect = document.getElementById("import-group");
const importGroupHint = document.getElementById("import-group-hint");
const importCancelBtn = document.getElementById("import-cancel");
const importConfirmBtn = document.getElementById("import-confirm");

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseImportFile(file.name, text);
    if (!parsed.length) {
      alert("No sentences found in that file.");
      e.target.value = "";
      return;
    }
    const groupColumnPresent = parsed.some((p) => p.groupNames && p.groupNames.length);
    state.pendingImport = { sentences: parsed, groupColumnPresent };
    showImportPreview();
  } catch (err) {
    alert("Could not read file: " + err.message);
  }
  e.target.value = "";
});

function showImportPreview() {
  const { sentences, groupColumnPresent } = state.pendingImport;
  importSummaryEl.textContent = `Found ${sentences.length} sentence${sentences.length === 1 ? "" : "s"}.`;
  importPreviewEl.hidden = false;
  importGroupHint.hidden = !groupColumnPresent;

  importGroupSelect.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "(none — keep imported group info only)";
  importGroupSelect.appendChild(noneOpt);
  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New group…";
  importGroupSelect.appendChild(newOpt);
  for (const g of state.groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    importGroupSelect.appendChild(opt);
  }
}

importCancelBtn.addEventListener("click", () => {
  state.pendingImport = null;
  importPreviewEl.hidden = true;
});

importConfirmBtn.addEventListener("click", async () => {
  if (!state.pendingImport) return;
  const { sentences } = state.pendingImport;
  let bulkGroupId = null;
  const sel = importGroupSelect.value;
  if (sel === "__new__") {
    const name = prompt("New group name?");
    if (!name) return;
    const g = getOrCreateGroup(name);
    bulkGroupId = g ? g.id : null;
  } else if (sel) {
    bulkGroupId = sel;
  }

  const newSentences = [];
  for (const item of sentences) {
    const groupIds = new Set();
    if (bulkGroupId) groupIds.add(bulkGroupId);
    for (const name of item.groupNames || []) {
      const g = getOrCreateGroup(name);
      if (g) groupIds.add(g.id);
    }
    const s = {
      id: uid(),
      english: item.english,
      korean: item.korean,
      groupIds: [...groupIds],
      audioPath: null,
      audioVoice: null,
      createdAt: Date.now(),
    };
    state.sentences.push(s);
    newSentences.push(s);
  }
  saveSentences();
  saveGroups();
  showSync("Importing…");
  try {
    await remoteBulkInsert(newSentences, []);
    showSync("");
  } catch (err) {
    console.error("import upload", err);
    showSync("Import upload failed", true);
  }
  state.pendingImport = null;
  importPreviewEl.hidden = true;
  alert(`Imported ${newSentences.length} sentence(s). Audio is being generated in the background.`);
  renderGroupChips();
  renderList();
  renderGroupsManagement();

  // Generate audio for each new sentence with a small concurrency cap so we
  // don't hammer the TTS API when importing a large batch.
  queueAudioGeneration(newSentences);
});

async function queueAudioGeneration(sentences, concurrency = 4) {
  if (!sentences.length) return;
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, sentences.length) }, async () => {
    while (i < sentences.length) {
      const s = sentences[i++];
      await generateAudioFor(s);
    }
  });
  await Promise.all(workers);
}

/* ---------- Import parsers ---------- */

function parseImportFile(filename, text) {
  const lower = filename.toLowerCase();
  const trimmed = text.trim();
  // Try JSON first if extension or shape suggests it.
  if (lower.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseImportJSON(JSON.parse(trimmed));
    } catch {
      // fall through to tabular
    }
  }
  // Choose delimiter
  const delimiter = lower.endsWith(".tsv") || /\t/.test(text.split("\n")[0] || "")
    ? "\t"
    : ",";
  const rows = parseDelimited(text, delimiter).filter((r) => r.some((c) => c.trim().length));
  if (!rows.length) return [];
  // Detect header
  const first = rows[0].map((c) => c.trim().toLowerCase());
  const looksLikeHeader =
    first[0] === "english" || first[0] === "en" || first[1] === "korean" || first[1] === "ko";
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  const out = [];
  for (const row of dataRows) {
    const english = (row[0] || "").trim();
    const korean = (row[1] || "").trim();
    if (!english || !korean) continue;
    const groupCell = (row[2] || "").trim();
    const groupNames = groupCell ? groupCell.split("|").map((s) => s.trim()).filter(Boolean) : [];
    out.push({ english, korean, groupNames });
  }
  return out;
}

function parseImportJSON(data) {
  // Accept either a v2 export ({ groups, sentences }) or a plain array.
  const groupsByOldId = new Map();
  if (data && Array.isArray(data.groups)) {
    for (const g of data.groups) {
      if (g && typeof g.name === "string") {
        groupsByOldId.set(g.id, g.name);
      }
    }
  }
  const arr = Array.isArray(data) ? data : Array.isArray(data?.sentences) ? data.sentences : [];
  const out = [];
  for (const item of arr) {
    if (typeof item.english !== "string" || typeof item.korean !== "string") continue;
    const groupNames = [];
    if (Array.isArray(item.groupIds)) {
      for (const gid of item.groupIds) {
        const name = groupsByOldId.get(gid);
        if (name) groupNames.push(name);
      }
    }
    if (Array.isArray(item.groups)) {
      for (const name of item.groups) {
        if (typeof name === "string") groupNames.push(name);
      }
    }
    out.push({ english: item.english, korean: item.korean, groupNames });
  }
  return out;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === delimiter) { row.push(field); field = ""; i++; continue; }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
        i++; continue;
      }
      field += c; i++;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ---------- Settings: clear all + sign out ---------- */

document.getElementById("clear-btn").addEventListener("click", async () => {
  if (!confirm("Delete ALL sentences? Groups will be kept. This cannot be undone.")) return;
  state.sentences = [];
  saveSentences();
  renderGroupChips();
  renderList();
  renderGroupsManagement();
  if (state.user) {
    showSync("Deleting…");
    const { error } = await sb.from("sentences").delete().eq("user_id", state.user.id);
    if (error) {
      console.error("clear all", error);
      showSync("Delete failed", true);
    } else {
      showSync("");
    }
  }
});

const signoutBtn = document.getElementById("signout-btn");
signoutBtn.addEventListener("click", async () => {
  if (!confirm("Sign out? Your local cache will be cleared.")) return;
  await sb.auth.signOut();
  // Wipe local cache so the next user (or re-sign-in) starts clean.
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(GROUPS_KEY);
  localStorage.removeItem(MIGRATION_KEY);
  location.reload();
});

/* ---------- Auth gate UI ---------- */

const authGateEl = document.getElementById("auth-gate");
const appHeaderEl = document.getElementById("app-header");
const appMainEl = document.getElementById("app-main");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authCode = document.getElementById("auth-code");
const authEmailLabel = document.getElementById("auth-email-label");
const authCodeLabel = document.getElementById("auth-code-label");
const authSubmit = document.getElementById("auth-submit");
const authRestart = document.getElementById("auth-restart");
const authStatus = document.getElementById("auth-status");
const accountEmailEl = document.getElementById("account-email");

let authStep = "email";       // "email" | "code"
let authPendingEmail = null;

function showAuthGate() {
  authGateEl.hidden = false;
  appHeaderEl.hidden = true;
  appMainEl.hidden = true;
}

function showApp(user) {
  authGateEl.hidden = true;
  appHeaderEl.hidden = false;
  appMainEl.hidden = false;
  if (accountEmailEl) {
    accountEmailEl.textContent = `Signed in as ${user.email}`;
  }
}

function setAuthStep(step) {
  authStep = step;
  if (step === "email") {
    authEmailLabel.hidden = false;
    authCodeLabel.hidden = true;
    authRestart.hidden = true;
    authSubmit.textContent = "Send code";
    authCode.value = "";
  } else {
    authEmailLabel.hidden = true;
    authCodeLabel.hidden = false;
    authRestart.hidden = false;
    authSubmit.textContent = "Verify code";
    setTimeout(() => authCode.focus(), 50);
  }
}

authRestart.addEventListener("click", () => {
  authPendingEmail = null;
  authStatus.className = "auth-status";
  authStatus.textContent = "";
  setAuthStep("email");
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (authStep === "email") {
    const email = authEmail.value.trim();
    if (!email) return;
    authSubmit.disabled = true;
    authStatus.className = "auth-status";
    authStatus.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    authSubmit.disabled = false;
    if (error) {
      authStatus.className = "auth-status error";
      authStatus.textContent = error.message;
      return;
    }
    authPendingEmail = email;
    setAuthStep("code");
    authStatus.className = "auth-status success";
    authStatus.textContent = `Code sent to ${email}. Check your inbox.`;
    return;
  }

  // Code step
  const token = authCode.value.trim();
  if (!token) return;
  authSubmit.disabled = true;
  authStatus.className = "auth-status";
  authStatus.textContent = "Verifying…";
  const { error } = await sb.auth.verifyOtp({
    email: authPendingEmail,
    token,
    type: "email",
  });
  authSubmit.disabled = false;
  if (error) {
    authStatus.className = "auth-status error";
    authStatus.textContent = error.message;
    return;
  }
  // Success: onAuthStateChange will swap to the app shell.
  authStatus.textContent = "";
});

// Surface any error returned in the URL hash (e.g. expired link from previous attempt).
(function showHashError() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const desc = params.get("error_description") || params.get("error");
  if (desc) {
    authStatus.className = "auth-status error";
    authStatus.textContent = desc.replace(/\+/g, " ");
    history.replaceState(null, "", location.pathname + location.search);
  }
})();

/* ---------- Service worker + persistent storage ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

/* ---------- Online/offline awareness ---------- */

window.addEventListener("online", () => {
  if (state.user) remoteSyncAll();
});
window.addEventListener("offline", () => {
  showSync("Offline", true);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user && navigator.onLine) {
    remoteSyncAll();
  }
});

/* ---------- Init ---------- */

async function init() {
  // Render whatever's in the local cache immediately for fast first paint.
  loadAll();
  applySettingsToControls();
  renderGroupChips();
  renderList();
  renderGroupCheckboxes();

  // Determine session.
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    showAuthGate();
    return;
  }
  state.user = session.user;
  showApp(session.user);
  await migrateLocalIfNeeded();
  await remoteSyncAll();
  renderGroupChips();
  renderList();
  renderGroupCheckboxes();
  if (document.getElementById("view-play").classList.contains("active")) {
    preparePlayer();
  }
}

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_IN" && session) {
    state.user = session.user;
    showApp(session.user);
    await migrateLocalIfNeeded();
    await remoteSyncAll();
    renderGroupChips();
    renderList();
    renderGroupCheckboxes();
  } else if (event === "SIGNED_OUT") {
    state.user = null;
    showAuthGate();
  }
});

init();
