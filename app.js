"use strict";

const STORAGE_KEY = "korean-sentences-v1";
const SETTINGS_KEY = "korean-settings-v1";
const GROUPS_KEY = "korean-groups-v1";

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
  player: {
    queue: [],
    index: 0,
    playing: false,
    wakeLock: null,
    abortTimer: null,
    sessionGroupId: null,
  },
};

/* ---------- Persistence + migration ---------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

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
  return g;
}

function deleteGroup(id) {
  state.groups = state.groups.filter((g) => g.id !== id);
  for (const s of state.sentences) {
    s.groupIds = (s.groupIds || []).filter((gid) => gid !== id);
  }
  if (state.settings.selectedGroupId === id) {
    state.settings.selectedGroupId = null;
    saveSettings();
  }
  saveGroups();
  saveSentences();
}

function renameGroup(id, newName) {
  const trimmed = newName.trim();
  if (!trimmed) return;
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  g.name = trimmed;
  saveGroups();
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
    speakKorean(s.korean);
  } else if (action === "edit") {
    startEdit(s);
  } else if (action === "delete") {
    if (confirm("Delete this sentence?")) {
      state.sentences = state.sentences.filter((x) => x.id !== id);
      saveSentences();
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

  if (state.editingId) {
    const s = state.sentences.find((x) => x.id === state.editingId);
    if (s) {
      s.english = english;
      s.korean = korean;
      s.groupIds = groupIds;
    }
  } else {
    state.sentences.unshift({
      id: uid(),
      english,
      korean,
      groupIds,
      createdAt: Date.now(),
    });
  }
  saveSentences();
  resetAddForm();
  renderGroupChips();
  renderList();
  showView("list");
});

previewBtn.addEventListener("click", () => {
  const text = koInput.value.trim();
  if (text) {
    cancelSpeech();
    speakKorean(text);
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

function speakKorean(text) {
  return speak(text, "ko-KR", { rate: state.settings.speed });
}

function speakEnglish(text) {
  return speak(text, "en-US", { rate: state.settings.speed });
}

function cancelSpeech() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
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
    if (seg.lang === "ko") await speakKorean(seg.text);
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
  playLoop();
}

function stopPlayback() {
  state.player.playing = false;
  cancelSpeech();
  abortSleep();
  setSpeakingHighlight(null);
  btnPlayPause.textContent = "▶";
  releaseWakeLock();
}

btnPlayPause.addEventListener("click", () => {
  if (state.player.playing) stopPlayback();
  else startPlayback();
});

btnPrev.addEventListener("click", () => {
  cancelSpeech();
  abortSleep();
  state.player.index = Math.max(0, state.player.index - 1);
  renderPlayerCurrent();
});

btnNext.addEventListener("click", () => {
  cancelSpeech();
  abortSleep();
  state.player.index = Math.min(state.player.queue.length - 1, state.player.index + 1);
  renderPlayerCurrent();
});

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

importConfirmBtn.addEventListener("click", () => {
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

  let added = 0;
  for (const item of sentences) {
    const groupIds = new Set();
    if (bulkGroupId) groupIds.add(bulkGroupId);
    for (const name of item.groupNames || []) {
      const g = getOrCreateGroup(name);
      if (g) groupIds.add(g.id);
    }
    state.sentences.push({
      id: uid(),
      english: item.english,
      korean: item.korean,
      groupIds: [...groupIds],
      createdAt: Date.now(),
    });
    added++;
  }
  saveSentences();
  saveGroups();
  state.pendingImport = null;
  importPreviewEl.hidden = true;
  alert(`Imported ${added} sentence(s).`);
  renderGroupChips();
  renderList();
  renderGroupsManagement();
});

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

/* ---------- Settings: clear all ---------- */

document.getElementById("clear-btn").addEventListener("click", () => {
  if (confirm("Delete ALL sentences? Groups will be kept. This cannot be undone.")) {
    state.sentences = [];
    saveSentences();
    renderGroupChips();
    renderList();
    renderGroupsManagement();
  }
});

/* ---------- Service worker + persistent storage ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// Ask the browser to mark our storage as persistent so it won't evict it
// under storage pressure. Browsers may grant or ignore; either way it's safe.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

/* ---------- Init ---------- */

loadAll();
applySettingsToControls();
renderGroupChips();
renderList();
renderGroupCheckboxes();
