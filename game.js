/*
 * Son Frekans — oyun mantığı.
 * Sıfır harici kütüphane: sürükleme saf Pointer Events ile, görsel bozulma saf CSS/JS ile yapılır.
 */

const STATS_MIN = 0;
const STATS_MAX = 100;
const SWIPE_COMMIT_PX = 120;
const MAX_ROTATE_DEG = 18;
const GLITCH_CHARS = ["#", "&", "%", "?"];

const state = {
  power: 70,
  trust: 50,
  sanity: 80,
  signal: 15,
  day: 1,
  tapeNumber: 1,
  currentCardId: null,
  currentTrueText: "",
  forcedNextId: null,
  usedThisPhase: new Set(),
  ended: false,
  showingIntro: false,
  isNight: false,
  pendingCallbacks: [], // { id, remaining, relKey?, variants? } — bir seçimin birkaç kart sonra geri dönen sonucu
  lastCardWasCallback: false, // renderCard'a "bu kart bir callback'ten geldi" bilgisini taşır
  relationships: { selin: 50, serkan: 50, military: 50, mert: 50, defne: 50 }, // NPC/faksiyon güven skorları (0-100)
  tuning: null, // { targetFreq, successCardId, failureCardId, currentFreq, lockStartedAt, offTargetAccumMs }
  hardwareFault: null, // { type: 'power' | 'oxygen' } — onarılana kadar kart çekimini kilitler
  buseSecretFound: false, // bu koşuda 94.2 MHz gizli kanalı zaten bulundu mu
  memoryLettersFound: [], // çözülmüş memory_letter kart id'leri — 4'ü tamamlanınca true_escape zinciri açılır
  memory: null, // { letterId, targetPhase, lockStartedAt } — aktif Zihin Eşleme oturumu
  characterFates: {}, // { mert/defne: final kart id, selin: "good"|"bad", ceylan: "stayed"|"left" } — bu koşuda netleşen kaderler
};

const els = {};
let recSeconds = 0;
let recTimerHandle = null;
let glitchTextHandle = null;

function qs(sel) { return document.querySelector(sel); }
function clamp(v) { return Math.max(STATS_MIN, Math.min(STATS_MAX, v)); }

function loadTapeNumber() {
  const saved = localStorage.getItem("sonFrekansTapeNumber");
  return saved ? parseInt(saved, 10) : 1;
}
function bumpTapeNumber() {
  const next = loadTapeNumber() + 1;
  localStorage.setItem("sonFrekansTapeNumber", String(next));
  return next;
}

function loadSetting(key, fallback) {
  const raw = localStorage.getItem(key);
  const n = raw !== null ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function saveSetting(key, value) {
  localStorage.setItem(key, String(value));
}

/* ---------- Bant Arşivi & Rekor Sistemi (localStorage) ---------- */
const TOTAL_ENDINGS = 9;
function loadDiscoveredEndings() {
  try {
    const raw = JSON.parse(localStorage.getItem("sonFrekansDiscoveredEndings") || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (e) {
    return new Set();
  }
}
function saveDiscoveredEndings(set) {
  localStorage.setItem("sonFrekansDiscoveredEndings", JSON.stringify([...set]));
}
function loadHighScoreDay() {
  return Math.round(loadSetting("sonFrekansHighScoreDay", 0));
}
function saveHighScoreDay(day) {
  saveSetting("sonFrekansHighScoreDay", day);
}
function formatArchiveLine() {
  const discovered = loadDiscoveredEndings().size;
  const highScore = loadHighScoreDay();
  return `Kayıtlı En Uzun Yayın: ${highScore} Gün | Keşfedilen Sonlar: ${discovered}/${TOTAL_ENDINGS}`;
}

/* ---------- Bant Arşivi: Mert/Buse final kasetleri (ölüm sonları dışındaki bonus kayıtlar) ---------- */
const CHARACTER_FINALES = {
  mert_finale_resolved: {
    title: "MERT: SADAKAT",
    transcript: "“Gitmeyi düşündüm ama gidemedim. Buradayım, seninle. Sonuna kadar.” Cephane sandığını sana geri veriyor.",
  },
  mert_finale_flee: {
    title: "MERT: KAÇIŞ",
    transcript: "Mert'i bulamıyorsun. Cephane sandığının yarısı da onunla birlikte gitmiş. Bir not bırakmış: “Üzgünüm. Daha fazla dayanamadım.”",
  },
  mert_finale_hostage: {
    title: "MERT: REHİNE KRİZİ",
    transcript: "Elinde silahla konsolun başında duruyor. “Kimse çıkmıyor, kimse girmiyor, ta ki bana gerçeği söyleyene kadar!”",
  },
  defne_epilogue_ally: {
    title: "BUSE: MÜTTEFİK",
    transcript: "“Sağ çıktık. İkimiz de.” Sesi ilk kez gerçekten rahatlamış geliyor. “Frekansımı hep açık tutacağım, ihtiyacın olursa.”",
  },
  defne_epilogue_neutral: {
    title: "BUSE: TARAFSIZ",
    transcript: "“Sağ çıktık ama... bilmiyorum artık kimin fikriydi bu, kimin sesiydi asıl. Belki bir süre konuşmasak iyi olur.”",
  },
  defne_epilogue_rival: {
    title: "BUSE: RAKİP",
    transcript: "Hattın sonunda Buse yok artık, ya da hiç yoktu. Sadece senin sesini tekrar eden bir statik var.",
  },
};
function loadDiscoveredFinales() {
  try {
    const raw = JSON.parse(localStorage.getItem("sonFrekansDiscoveredFinales") || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (e) {
    return new Set();
  }
}
function saveDiscoveredFinale(id) {
  const set = loadDiscoveredFinales();
  set.add(id);
  localStorage.setItem("sonFrekansDiscoveredFinales", JSON.stringify([...set]));
}

/* ---------- Karakter Dosyası (Character Codex) ----------
   Betimlemeler her zaman görünür; durum satırı ya bu koşuda/geçmişte netleşmiş kesin bir kadere
   (bkz. CHARACTER_FINALES, sel_supply_4_*, ceylan_leaving_thought) ya da güncel ilişki seviyesine
   göre üretilir. Kesin kader bir kez localStorage'a yazılınca (saveCharacterFate) kalıcı kalır —
   Bant Arşivi'ndeki final kayıtlarıyla aynı mantık. */
const CHARACTER_PROFILES = [
  {
    key: "ceylan",
    name: CAST.ceylan,
    image: "images/ceylan.jpg",
    bio: "Sığınağın son mühendisi. Jeneratörü ve vericiyi tek başına ayakta tutuyor, kendi sağlığını hiç önemsemeden. Bir gün gitmeyi düşündüğünü söylüyor ama hep kalıyor.",
  },
  {
    key: "serkan",
    name: CAST.serkan,
    image: "images/serkan.jpg",
    bio: "Bölgeden kaçan bir asker. Sana güvenip güvenemeyeceğine hâlâ karar veremedi, ama telsizi hiç kapatmıyor.",
  },
  {
    key: "selin",
    name: "Selin (Sığınak-12)",
    image: "images/selin.jpg",
    bio: "Komşu bir sığınağın lideri. Elindeki insanları hayatta tutmaya çalışıyor, zor kararlar için sana danışıyor.",
  },
  {
    key: "mert",
    name: CAST.mert,
    image: "images/mert.jpg",
    bio: "İstasyonun eski nöbetçisi. Kapıda donarak bulundu, o günden beri sığınakta kalıyor.",
  },
  {
    key: "defne",
    name: CAST.defne,
    image: "images/buse.jpg",
    bio: "Korsan bir telsizci. Resmi kanallardan uzak duruyor, kendi gizli hattından seninle temas kuruyor.",
  },
  {
    key: "fisilti",
    name: CAST.fisilti,
    image: "images/fisilti.jpg",
    bio: "88.4 MHz'de yaşayan bir şey. Sinyal ne kadar güçlenirse, sesi o kadar netleşiyor.",
  },
];

const CEYLAN_FATE_TEXT = {
  stayed: "Kalmanı istedin. Hâlâ burada, seninle.",
  left: "Gitmesine izin verdin. O günden beri telsizde yok.",
};
const SELIN_FATE_TEXT = {
  good: "Sığınak-12 ayakta kaldı. Sana borçlu olduklarını söylüyorlar.",
  bad: "Kayıp. Sığınak-12'den kimse ona ulaşamıyor.",
};
const FISILTI_STATUS_TIERS = [
  { min: 75, label: "HÂKİM", cls: "tier-broken", text: "Artık neredeyse her cümlenin arasına sızıyor." },
  { min: 50, label: "YAKIN", cls: "tier-tense", text: "Sesini net duyuyorsun, bazen kendi sesinle karışıyor." },
  { min: 25, label: "HAFİF", cls: "tier-stable", text: "Ara sıra bir fısıltı, belki de sadece parazit." },
  { min: 0, label: "SESSİZ", cls: "tier-strong", text: "Şu an sessiz. Belki de hiç var olmadı." },
];

function loadCharacterFates() {
  try {
    return JSON.parse(localStorage.getItem("sonFrekansCharacterFates") || "{}");
  } catch (e) {
    return {};
  }
}
function saveCharacterFate(key, value) {
  const fates = loadCharacterFates();
  fates[key] = value;
  localStorage.setItem("sonFrekansCharacterFates", JSON.stringify(fates));
}

function getCharacterStatus(profile) {
  // Canlı (bu koşuda netleşen) kader, kalıcı kayıttan önce gelir.
  const fates = { ...loadCharacterFates(), ...state.characterFates };

  if ((profile.key === "mert" || profile.key === "defne") && fates[profile.key] && CHARACTER_FINALES[fates[profile.key]]) {
    const finale = CHARACTER_FINALES[fates[profile.key]];
    return { label: finale.title, cls: "tier-strong", text: finale.transcript };
  }
  if (profile.key === "selin" && fates.selin) {
    return {
      label: fates.selin === "good" ? "GÜVENDE" : "KAYIP",
      cls: fates.selin === "good" ? "tier-strong" : "tier-broken",
      text: SELIN_FATE_TEXT[fates.selin],
    };
  }
  if (profile.key === "ceylan" && fates.ceylan) {
    return {
      label: fates.ceylan === "stayed" ? "YANINDA" : "AYRILDI",
      cls: fates.ceylan === "stayed" ? "tier-strong" : "tier-tense",
      text: CEYLAN_FATE_TEXT[fates.ceylan],
    };
  }
  if (profile.key === "fisilti") {
    const tier = FISILTI_STATUS_TIERS.find((t) => state.signal >= t.min);
    return { label: tier.label, cls: tier.cls, text: tier.text };
  }
  if (state.relationships[profile.key] !== undefined) {
    const tier = relationshipTier(state.relationships[profile.key]);
    return { label: tier.label, cls: tier.cls, text: `Şu anki bağ seviyesi: ${tier.label.toLocaleLowerCase("tr")}.` };
  }
  return { label: "BİLİNMİYOR", cls: "", text: "Henüz bu kişi hakkında kesin bir şey öğrenmedin." };
}

function populateCharacterCodex() {
  els.codexList.innerHTML = "";
  CHARACTER_PROFILES.forEach((profile) => {
    const status = getCharacterStatus(profile);
    const card = document.createElement("div");
    card.className = "codex-card";
    card.innerHTML = `
      <img class="codex-portrait" src="${profile.image}" alt="">
      <div class="codex-info">
        <div class="codex-name">${profile.name}</div>
        <div class="codex-bio">${profile.bio}</div>
        <div class="codex-status ${status.cls}"><span class="status-label">[ ${status.label} ]</span> ${status.text}</div>
      </div>`;
    els.codexList.appendChild(card);
  });
}
function openCharacterCodex() {
  populateCharacterCodex();
  els.codexOverlay.classList.add("show");
}
function closeCharacterCodex() {
  els.codexOverlay.classList.remove("show");
}

/* ---------- Yarım kalmış yayın (Yayına Devam Et) ---------- */
const SAVED_GAME_KEY = "sonFrekansSavedGame";
function saveGameProgress() {
  const snapshot = {
    day: state.day,
    power: state.power,
    trust: state.trust,
    sanity: state.sanity,
    signal: state.signal,
    tapeNumber: state.tapeNumber,
    currentCardId: state.currentCardId,
    forcedNextId: state.forcedNextId,
    pendingCallbacks: state.pendingCallbacks,
    usedThisPhase: [...state.usedThisPhase],
    isNight: state.isNight,
    relationships: state.relationships,
    hardwareFault: state.hardwareFault,
    buseSecretFound: state.buseSecretFound,
    memoryLettersFound: state.memoryLettersFound,
    characterFates: state.characterFates,
  };
  localStorage.setItem(SAVED_GAME_KEY, JSON.stringify(snapshot));
}
function loadGameProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_GAME_KEY));
    return raw && typeof raw.day === "number" ? raw : null;
  } catch (e) {
    return null;
  }
}
function clearGameProgress() {
  localStorage.removeItem(SAVED_GAME_KEY);
}
function hasSavedGame() {
  return !!loadGameProgress();
}

/* ---------- Gece Vardiyası: her 4 günde bir gündüz/gece döngüsü ---------- */
function isNight(day) {
  return Math.floor(Math.max(0, day - 1) / 4) % 2 === 1;
}
function updateNightShift() {
  state.isNight = isNight(state.day);
  document.documentElement.classList.toggle("night-shift", state.isNight);
}

/* ---------- Gösterge <-> etki anahtarı eşleşmesi (damga/ping için) ---------- */
const METER_SELECTORS = {
  power: ".m-fuel",
  trust: ".m-trust",
  sanity: ".m-sanity",
  signal: ".m-signal",
};

/* ---------- Gecikmeli geri bildirim: ilişki skoruna göre varyant seçimi ---------- */
function resolveCallbackCard(due) {
  if (due.variants) {
    const score = due.relKey ? (state.relationships[due.relKey] ?? 50) : 50;
    const match = [...due.variants].sort((a, b) => b.min - a.min).find((v) => score >= v.min);
    const id = match ? match.id : due.id;
    return DECK.find((c) => c.id === id);
  }
  return DECK.find((c) => c.id === due.id);
}

/* ---------- Kart seçimi / render ---------- */
/* ---------- Hafıza Mektupları: belirli günlerde zorla devreye giren anlatı kartları ---------- */
const MEMORY_LETTER_DAYS = { 10: "memory_letter_1", 25: "memory_letter_2", 40: "memory_letter_3", 55: "memory_letter_4" };
function pendingMemoryLetterId() {
  const days = Object.keys(MEMORY_LETTER_DAYS).map(Number).sort((a, b) => a - b);
  for (const d of days) {
    const id = MEMORY_LETTER_DAYS[d];
    if (state.day >= d && !state.memoryLettersFound.includes(id)) return id;
  }
  return null;
}

function pickCard() {
  state.lastCardWasCallback = false;
  if (state.forcedNextId) {
    const forced = DECK.find((c) => c.id === state.forcedNextId);
    state.forcedNextId = null;
    if (forced) return forced;
  }
  const letterId = pendingMemoryLetterId();
  if (letterId) {
    const letterCard = DECK.find((c) => c.id === letterId);
    if (letterCard) return letterCard;
  }
  const dueIndex = state.pendingCallbacks.findIndex((cb) => cb.remaining <= 0);
  if (dueIndex !== -1) {
    const due = state.pendingCallbacks.splice(dueIndex, 1)[0];
    const card = resolveCallbackCard(due);
    if (card) {
      state.lastCardWasCallback = true;
      return card;
    }
  }
  const phase = phaseForDay(state.day);
  let pool = cardsForPhase(phase).filter((c) => !state.usedThisPhase.has(c.id));
  if (pool.length === 0) {
    state.usedThisPhase.clear();
    pool = cardsForPhase(phase);
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

const CALLBACK_WHISPER_INJECTIONS = [
  "Bunu sen mi yaptın, yoksa frekans mı uyduruyor?",
  "Bunu gerçekten hatırlıyor musun?",
  "Belki de bu hiç olmadı.",
  "Sana bunu daha önce de anlatmış mıydım?",
];

/* ---------- Akıl Sağlığı Çöküş Katmanı (sanity < 35) ---------- */
const SANITY_CRISIS_THRESHOLD = 35;
const ZALGO_MARKS = ["̀", "́", "̖", "̗", "҉", "͟", "̴", "̵"];
const WORD_FLICKER_MS = 400;

function zalgoify(word) {
  return word.split("").map((ch) => {
    let out = ch;
    const markCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < markCount; i++) out += ZALGO_MARKS[Math.floor(Math.random() * ZALGO_MARKS.length)];
    return out;
  }).join("");
}

let wordFlickerUntil = 0;
function maybeFlickerWord() {
  if (Date.now() < wordFlickerUntil) return;
  const words = state.currentTrueText.split(" ");
  if (words.length < 2) return;
  const idx = Math.floor(Math.random() * words.length);
  const rendered = words.map((w, i) => (i === idx ? `<span class="zalgo-word">${zalgoify(w)}</span>` : w)).join(" ");
  els.quoteText.innerHTML = rendered;
  wordFlickerUntil = Date.now() + WORD_FLICKER_MS;
  setTimeout(() => {
    if (!state.ended) els.quoteText.textContent = state.currentTrueText;
  }, WORD_FLICKER_MS);
}

/* Portre sonar dalgası: basılı tutunca (pointerdown) dışa doğru genişleyip silinen halka.
   .portrait-wrap'ın kendi overflow:hidden'ı halkayı kırpacağından, halka bir kardeş öğe olarak
   .card-content'e eklenir ve konumu portrenin gerçek dikdörtgenine göre satır-içi hesaplanır. */
const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function spawnSonarWave() {
  if (prefersReducedMotion) return; // animasyon CSS'te kapalı; animationend hiç tetiklenmez, halka temizlenemezdi
  const container = els.portraitWrap.parentElement;
  const contentRect = container.getBoundingClientRect();
  const portraitRect = els.portraitWrap.getBoundingClientRect();
  const ring = document.createElement("span");
  ring.className = "sonar-ring";
  ring.style.left = (portraitRect.left - contentRect.left) + "px";
  ring.style.top = (portraitRect.top - contentRect.top) + "px";
  ring.style.width = portraitRect.width + "px";
  ring.style.height = portraitRect.height + "px";
  ring.style.color = getComputedStyle(els.portraitWrap).borderColor;
  container.appendChild(ring);
  ring.addEventListener("animationend", () => ring.remove());
}
function bindPortraitEvents() {
  // stopPropagation YOK: portreden başlayan bir sürükleme normal kart swipe'ını kesintiye uğratmamalı.
  els.portraitWrap.addEventListener("pointerdown", spawnSonarWave);
}

/* Mert/Buse portresi: Akıl <20 iken birkaç saniyede bir anlık tekinsiz negatif-flaş. */
function schedulePortraitHorrorFlash() {
  const delay = 2000 + Math.random() * 1200;
  setTimeout(() => {
    const hasCharacterAvatar = els.portraitWrap.classList.contains("avatar-mert") || els.portraitWrap.classList.contains("avatar-buse");
    if (!state.ended && !state.hardwareFault && state.sanity < 20 && hasCharacterAvatar) {
      els.portraitWrap.classList.add("horror-flash");
      setTimeout(() => els.portraitWrap.classList.remove("horror-flash"), 220);
    }
    schedulePortraitHorrorFlash();
  }, delay);
}

/* ---------- Mert/Buse portre parıltısı + gizli güven göstergesi ---------- */
const RELATIONSHIP_TIERS = [
  { min: 75, label: "GÜÇLÜ", cls: "tier-strong" },
  { min: 45, label: "DENGELİ", cls: "tier-stable" },
  { min: 20, label: "GERGİN", cls: "tier-tense" },
  { min: 0, label: "KOPUK", cls: "tier-broken" },
];
function relationshipTier(score) {
  return RELATIONSHIP_TIERS.find((t) => score >= t.min) || RELATIONSHIP_TIERS[RELATIONSHIP_TIERS.length - 1];
}

function updateRelationshipDisplay(card) {
  els.portraitWrap.classList.remove("avatar-mert", "avatar-buse");
  els.relationshipHud.classList.remove("tier-strong", "tier-stable", "tier-tense", "tier-broken");

  let relKey = null;
  if (card.speaker === CAST.mert) {
    els.portraitWrap.classList.add("avatar-mert");
    relKey = "mert";
  } else if (card.speaker === CAST.defne) {
    els.portraitWrap.classList.add("avatar-buse");
    relKey = "defne";
  }

  if (relKey) {
    const tier = relationshipTier(state.relationships[relKey] ?? 50);
    els.relationshipHud.textContent = `[ BAĞ: ${tier.label} ]`;
    els.relationshipHud.classList.add(tier.cls);
    els.relationshipHud.classList.add("show");
  } else {
    els.relationshipHud.classList.remove("show");
  }
}

/* ---------- Kart arkası: seçim etki tahminleri (PWR ▲, SAN ▼ vb.) ---------- */
const IMPACT_METER_META = {
  power: { label: "PWR", varName: "--meter-fuel" },
  trust: { label: "TRS", varName: "--meter-trust" },
  sanity: { label: "SAN", varName: "--meter-sanity" },
  signal: { label: "SIG", varName: "--meter-signal" },
};

function renderImpactHints(container, effects) {
  container.innerHTML = "";
  if (!effects) return;
  Object.entries(IMPACT_METER_META).forEach(([key, meta]) => {
    const val = effects[key];
    if (typeof val !== "number" || val === 0) return;
    const tag = document.createElement("span");
    tag.className = "impact-tag";
    tag.style.color = `var(${meta.varName})`;
    tag.textContent = `${meta.label} ${val > 0 ? "▲" : "▼"}`;
    container.appendChild(tag);
  });
}

/* ========================================================================
   HAFIZA MEKTUPLARI & ZİHİN EŞLEME (Memory Lore Engine)
   ======================================================================== */
const MEMORY_SANITY_BONUS = 15;
const MEMORY_LOCK_TOLERANCE = 6; // 0-100 faz ölçeğinde, dairesel mesafe
const MEMORY_LOCK_MS = 1200;
const MEMORY_TICK_MS = 80;

/* {{...}} işaretli bölümleri sansürlü (siyah bar) ya da açık (revealed) render eder.
   innerHTML kullanılmaz — her parça textContent/createElement ile eklenir, injection riski yok. */
function renderLetterText(container, rawText, revealed) {
  container.innerHTML = "";
  const regex = /\{\{(.*?)\}\}/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(rawText))) {
    if (match.index > lastIndex) container.appendChild(document.createTextNode(rawText.slice(lastIndex, match.index)));
    const span = document.createElement("span");
    span.className = revealed ? "redacted revealed" : "redacted";
    span.textContent = revealed ? match[1] : "█".repeat(Math.max(4, match[1].length));
    container.appendChild(span);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < rawText.length) container.appendChild(document.createTextNode(rawText.slice(lastIndex)));
}

function buildWavePath(phaseDeg) {
  const width = 300, height = 80, midY = height / 2, amplitude = 22, cycles = 3;
  const phaseRad = (phaseDeg / 100) * Math.PI * 2;
  const points = [];
  for (let x = 0; x <= width; x += 6) {
    const y = midY + amplitude * Math.sin((x / width) * cycles * 2 * Math.PI + phaseRad);
    points.push(`${x === 0 ? "M" : "L"}${x},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

function phaseDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 100 - d);
}

let memoryTickHandle = null;
function startMemoryResonance(card) {
  state.memory = { letterId: card.id, targetPhase: Math.floor(Math.random() * 100), lockStartedAt: null };
  els.memoryLetter.hidden = true;
  els.memoryResonance.hidden = false;
  els.memoryLed.classList.remove("tuned");
  els.memoryStatusText.textContent = "AYARLANIYOR...";
  els.memoryLockFill.style.width = "0%";
  els.memorySlider.value = String(Math.floor(Math.random() * 100));
  els.memorySlider.style.setProperty("--fill", els.memorySlider.value + "%");
  els.memoryWaveRef.setAttribute("d", buildWavePath(state.memory.targetPhase));
  els.memoryWavePlayer.setAttribute("d", buildWavePath(Number(els.memorySlider.value)));
  AudioEngine.ensure();
  if (memoryTickHandle) clearInterval(memoryTickHandle);
  memoryTickHandle = setInterval(memoryResonanceTick, MEMORY_TICK_MS);
}

function memoryResonanceTick() {
  const m = state.memory;
  if (!m) return;
  const current = Number(els.memorySlider.value);
  const distance = phaseDistance(current, m.targetPhase);
  if (distance <= MEMORY_LOCK_TOLERANCE) {
    if (!m.lockStartedAt) m.lockStartedAt = Date.now();
    const held = Date.now() - m.lockStartedAt;
    els.memoryLed.classList.add("tuned");
    els.memoryStatusText.textContent = "EŞLEŞİYOR...";
    els.memoryLockFill.style.width = Math.min(100, (held / MEMORY_LOCK_MS) * 100) + "%";
    if (held >= MEMORY_LOCK_MS) completeMemoryResonance();
  } else {
    m.lockStartedAt = null;
    els.memoryLed.classList.remove("tuned");
    els.memoryStatusText.textContent = "AYARLANIYOR...";
    els.memoryLockFill.style.width = "0%";
  }
}

function completeMemoryResonance() {
  if (memoryTickHandle) { clearInterval(memoryTickHandle); memoryTickHandle = null; }
  const letterId = state.memory.letterId;
  state.memory = null;
  if (!state.memoryLettersFound.includes(letterId)) state.memoryLettersFound.push(letterId);
  applyEffects({ sanity: MEMORY_SANITY_BONUS });
  updateHUD();
  AudioEngine.playMemoryRevealChime();
  vibrate(60);

  const card = DECK.find((c) => c.id === letterId);
  els.memoryResonance.hidden = true;
  els.memoryLetter.hidden = false;
  renderLetterText(els.memoryLetterText, card.text, true);
  els.memoryFocusBtn.hidden = true;
  els.memoryContinueBtn.hidden = false;
}

function onMemoryContinue() {
  els.memoryLetter.hidden = true;
  document.documentElement.classList.remove("memory-mode");
  els.cardStage.classList.remove("memory-active");
  state.day += 1;
  updateNightShift();
  updateHUD();
  if (state.memoryLettersFound.length >= 4) {
    // Dört mektup da çözüldü (bu fonksiyon yalnızca bir mektup çözülünce çağrılır, dolayısıyla
    // bu dal en fazla bir kez — tam dördüncü mektupta — tetiklenir): gizli final zincirini kuyruğa al.
    state.forcedNextId = "memory_code_complete";
  }
  const endingKey = checkEnding();
  if (endingKey) {
    triggerEnding(endingKey);
    return;
  }
  advanceToNextCard();
}

function bindMemoryEvents() {
  els.memoryFocusBtn.addEventListener("click", () => {
    const card = DECK.find((c) => c.id === state.currentCardId);
    startMemoryResonance(card);
  });
  els.memoryContinueBtn.addEventListener("click", onMemoryContinue);
  els.memorySlider.addEventListener("pointerdown", (e) => e.stopPropagation());
  els.memorySlider.addEventListener("input", () => {
    els.memorySlider.style.setProperty("--fill", els.memorySlider.value + "%");
    els.memoryWavePlayer.setAttribute("d", buildWavePath(Number(els.memorySlider.value)));
  });
}

function renderCard(card, { animateIn = true } = {}) {
  state.currentCardId = card.id;
  state.usedThisPhase.add(card.id);

  // Akıl <20 iken bir callback kartı geldiyse, metne manipülatif bir fısıltı sızıyor.
  if (state.lastCardWasCallback && state.sanity < 20) {
    const whisper = CALLBACK_WHISPER_INJECTIONS[Math.floor(Math.random() * CALLBACK_WHISPER_INJECTIONS.length)];
    state.currentTrueText = `${card.text} (${whisper})`;
  } else {
    state.currentTrueText = card.text;
  }

  els.cardImage.src = card.image;
  els.speaker.textContent = card.speaker;
  // memory_letter kartlarında ham metin {{...}} işaretleyicileri taşır — burada değil,
  // yalnızca renderLetterText ile .memory-letter-text içinde (sansürlü/açık) gösterilir.
  els.quoteText.textContent = card.type === "memory_letter" ? "Eski bir kağıt parçası elinde titriyor." : state.currentTrueText;
  els.quoteText.classList.remove("hallucinating");

  updateRelationshipDisplay(card);

  const isTuneCard = card.type === "radio_tune";
  const isMemoryCard = card.type === "memory_letter";
  els.choices.hidden = isTuneCard || isMemoryCard;
  els.tuner.hidden = !isTuneCard;
  els.cardStage.classList.toggle("tuning-active", isTuneCard);
  if (!isTuneCard && !isMemoryCard) {
    els.leftLabel.textContent = card.left.label;
    els.rightLabel.textContent = card.right.label;
    renderImpactHints(els.impactLeft, card.left.effects);
    renderImpactHints(els.impactRight, card.right.effects);
  }

  // Her yeni kart ön yüzle başlar; Tuner/Hafıza kartlarında çevirmenin bir anlamı yok
  // (arka yüzde seçenek olmadığından) — çevirme düğmeleri o kartlarda tamamen gizleniyor.
  els.cardFlipper.classList.remove("flipped");
  els.card.classList.toggle("no-flip", isTuneCard || isMemoryCard);

  // Bir önceki kartta arıza/gizli kanal/hafıza katmanı açık kalmış olabilir — yeni kartta sıfırla.
  els.hardwareFault.hidden = true;
  els.cardStage.classList.remove("fault-active");
  els.buseSecretBanner.classList.remove("show");
  els.portraitWrap.style.display = "";
  els.memoryLetter.hidden = !isMemoryCard;
  els.memoryResonance.hidden = true;
  els.cardStage.classList.toggle("memory-active", isMemoryCard);
  document.documentElement.classList.toggle("memory-mode", isMemoryCard);
  if (isMemoryCard) {
    els.portraitWrap.style.display = "none"; // yıpranmış mektup panosuna yer açmak için portre gizlenir
    renderLetterText(els.memoryLetterText, card.text, false);
    els.memoryFocusBtn.hidden = false;
    els.memoryContinueBtn.hidden = true;
  }

  // Bant Arşivi: Mert/Buse finaline ulaşıldıysa kalıcı bir kaset kaydı düşer.
  if (CHARACTER_FINALES[card.id]) {
    saveDiscoveredFinale(card.id);
    const charKey = card.id.startsWith("mert_") ? "mert" : "defne";
    state.characterFates[charKey] = card.id;
    saveCharacterFate(charKey, card.id);
  }
  // Karakter Dosyası: Selin'in erzak krizinin kesin sonucu.
  if (card.id === "sel_supply_4_good" || card.id === "sel_supply_4_bad") {
    const fate = card.id === "sel_supply_4_good" ? "good" : "bad";
    state.characterFates.selin = fate;
    saveCharacterFate("selin", fate);
  }

  const isIntroCard = card.id === "__intro__";
  els.archiveLineIntro.hidden = !isIntroCard;
  if (isIntroCard) els.archiveLineIntro.textContent = formatArchiveLine();

  els.card.style.transform = "";
  els.card.classList.remove("fly-out", "snap-back", "resisting");
  if (animateIn) {
    els.card.classList.remove("enter");
    void els.card.offsetWidth;
    els.card.classList.add("enter");
  }
  updateChoiceHighlight(0);
  refreshGlitchTextLoop();

  // Gece Vardiyası: kartlar arasında %35 ihtimalle arkadan metalik kapı zorlanma sesi gelir.
  if (state.isNight && !isIntroCard && Math.random() < 0.35) {
    AudioEngine.playDoorCreak();
  }

  if (isTuneCard) startTuning(card);
}

/* ---------- İnteraktif Telsiz Frekans Arama (Tuner Mini-Oyunu) ---------- */
const TUNE_MIN_FREQ = 88.0;
const TUNE_MAX_FREQ = 108.0;
const TUNE_TOLERANCE = 0.5;
const TUNE_LOCK_MS = 1200;
const TUNE_SANITY_DRAIN_INTERVAL = 2000;
const TUNE_SANITY_DRAIN_AMOUNT = 2;
const TUNE_FAIL_SANITY = 15;
const TUNE_TICK_MS = 80;

let tuningTickHandle = null;
let tuningDragging = false;

function startTuning(card) {
  state.tuning = {
    targetFreq: card.targetFreq,
    successCardId: card.successCardId,
    failureCardId: card.failureCardId,
    currentFreq: TUNE_MIN_FREQ + Math.random() * (TUNE_MAX_FREQ - TUNE_MIN_FREQ),
    lockStartedAt: null,
    offTargetAccumMs: 0,
  };
  els.tunerLed.classList.remove("tuned", "locked");
  els.tunerStatusText.textContent = "ARIYOR...";
  els.tunerLockFill.style.width = "0%";
  AudioEngine.startTunerNoise();
  updateTunerUI();
  if (tuningTickHandle) clearInterval(tuningTickHandle);
  tuningTickHandle = setInterval(tuningTick, TUNE_TICK_MS);
}

function freqToPercent(freq) {
  return ((freq - TUNE_MIN_FREQ) / (TUNE_MAX_FREQ - TUNE_MIN_FREQ)) * 100;
}

function updateTunerUI() {
  const t = state.tuning;
  if (!t) return;
  els.tunerFreq.textContent = t.currentFreq.toFixed(1).padStart(5, "0");
  els.tunerNeedle.style.left = freqToPercent(t.currentFreq) + "%";
}

function tuningTick() {
  const t = state.tuning;
  if (!t) return;

  // Buse Canlı Telsiz Frekansı: hangi Tuner kartında olursa olsun, 94.2 MHz'e kilitlenmek
  // kartın kendi hedefinden bağımsız gizli bir kanalı açar (bkz. STORY_META / title screen ipucu).
  if (!state.buseSecretFound) {
    const buseDistance = Math.abs(t.currentFreq - SECRET_BUSE_FREQ);
    if (buseDistance <= SECRET_BUSE_TOLERANCE) {
      t.buseHoldStartedAt = t.buseHoldStartedAt || Date.now();
      if (Date.now() - t.buseHoldStartedAt >= SECRET_BUSE_HOLD_MS) {
        triggerBuseSecretChannel();
        return;
      }
    } else {
      t.buseHoldStartedAt = null;
    }
  }

  const distance = Math.abs(t.currentFreq - t.targetFreq);
  const inTolerance = distance <= TUNE_TOLERANCE;
  const maxDistance = Math.max(t.targetFreq - TUNE_MIN_FREQ, TUNE_MAX_FREQ - t.targetFreq);
  const proximity = 1 - clampNum(distance / maxDistance, 0, 1); // 0: uzak, 1: tam üstünde
  AudioEngine.updateTunerNoise(1 - proximity);

  if (inTolerance) {
    t.offTargetAccumMs = 0;
    if (!t.lockStartedAt) t.lockStartedAt = Date.now();
    const held = Date.now() - t.lockStartedAt;
    els.tunerLed.classList.add("tuned");
    els.tunerStatusText.textContent = "TUNED";
    els.tunerLockFill.style.width = Math.min(100, (held / TUNE_LOCK_MS) * 100) + "%";
    if (held >= TUNE_LOCK_MS) {
      els.tunerLed.classList.add("locked");
      els.tunerStatusText.textContent = "SIGNAL LOCKED";
      completeTuning(true);
    }
  } else {
    t.lockStartedAt = null;
    els.tunerLed.classList.remove("tuned", "locked");
    els.tunerStatusText.textContent = "ARIYOR...";
    els.tunerLockFill.style.width = "0%";
    t.offTargetAccumMs += TUNE_TICK_MS;
    if (t.offTargetAccumMs >= TUNE_SANITY_DRAIN_INTERVAL) {
      t.offTargetAccumMs -= TUNE_SANITY_DRAIN_INTERVAL;
      applyEffects({ sanity: -TUNE_SANITY_DRAIN_AMOUNT });
      updateHUD();
    }
    if (state.sanity <= TUNE_FAIL_SANITY) {
      completeTuning(false);
    }
  }
}

function stopTuning() {
  if (tuningTickHandle) { clearInterval(tuningTickHandle); tuningTickHandle = null; }
  AudioEngine.stopTunerNoise();
  state.tuning = null;
  els.cardStage.classList.remove("tuning-active");
}

/* ---------- Buse Canlı Telsiz Frekansı (94.2 MHz gizli kanal) ---------- */
const SECRET_BUSE_FREQ = 94.2;
const SECRET_BUSE_TOLERANCE = 0.3;
const SECRET_BUSE_HOLD_MS = 1400;

function triggerBuseSecretChannel() {
  stopTuning();
  state.buseSecretFound = true;
  AudioEngine.playBuseSecretSting();
  vibrate([30, 60, 30]);
  els.buseSecretBanner.classList.add("show");

  state.day += 1;
  updateNightShift();
  updateHUD();

  const endingKey = checkEnding();
  if (endingKey) {
    triggerEnding(endingKey);
    return;
  }
  state.forcedNextId = "defne_secret_channel";
  setTimeout(() => advanceToNextCard(), 900);
}

/* ---------- Ortak "sıradaki karta geç" akışı: swipe ve Tuner çözümü burada birleşir,
   böylece Sığınak Donanım Arıza Döngüsü her iki yoldan da devreye girebilir. ---------- */
function advanceToNextCard() {
  if (maybeTriggerHardwareFault()) {
    renderHardwareFault();
    saveGameProgress();
    return;
  }
  const next = pickCard();
  renderCard(next);
  saveGameProgress();
}

/* ========================================================================
   SIĞINAK DONANIM ARIZA DÖNGÜSÜ
   ======================================================================== */
const HARDWARE_FAULT_BASE_CHANCE = 0.05;
const HARDWARE_FAULT_LOWPOWER_CHANCE = 0.4;
const HARDWARE_FAULT_LOW_POWER_THRESHOLD = 25;
const REPAIR_HOLD_MS = 3000;
const OXYGEN_DRAIN_INTERVAL_MS = 4000;
const OXYGEN_DRAIN_AMOUNT = 5;

const HARDWARE_FAULTS = {
  power: {
    title: "[ PWR_CRITICAL ]",
    cls: "fault-power",
    desc: "Jeneratör aşırı ısındı, türbin kilitlenmek üzere. Elle resetlemezsen yayın tamamen kesilebilir.",
  },
  oxygen: {
    title: "[ OXYGEN_FAIL ]",
    cls: "fault-oxygen",
    desc: "Havalandırma filtresi tıkandı. Giderilmezse her birkaç saniyede bir Akıl'ını törpüler.",
  },
};

function maybeTriggerHardwareFault() {
  if (state.hardwareFault || state.ended) return false;
  const chance = state.power < HARDWARE_FAULT_LOW_POWER_THRESHOLD ? HARDWARE_FAULT_LOWPOWER_CHANCE : HARDWARE_FAULT_BASE_CHANCE;
  if (Math.random() >= chance) return false;
  state.hardwareFault = { type: Math.random() < 0.5 ? "power" : "oxygen" };
  return true;
}

function renderHardwareFault() {
  const fault = state.hardwareFault;
  const meta = HARDWARE_FAULTS[fault.type];
  els.choices.hidden = true;
  els.tuner.hidden = true;
  els.hardwareFault.hidden = false;
  els.cardStage.classList.add("fault-active");
  els.card.classList.add("no-flip");
  els.cardFlipper.classList.remove("flipped");
  // Önceki kartın portresi/metni arıza panelinin altında kalıp kartı taşırmasın diye gizlenir
  // (inline style ile — [hidden] üzerinden gitmek burada .quote-text/.portrait-wrap'ın kendi
  // display:flex kuralıyla aynı özgüllükte çakışır, bkz. proje genelindeki [hidden] tuzağı).
  els.portraitWrap.style.display = "none";
  els.speaker.textContent = "SİSTEM UYARISI";
  els.quoteText.textContent = "";
  els.relationshipHud.classList.remove("show");
  els.faultTitle.textContent = meta.title;
  els.faultTitle.className = `fault-title ${meta.cls}`;
  els.faultDesc.textContent = meta.desc;
  els.repairFill.style.width = "0%";
  els.repairBtn.classList.remove("holding");
  AudioEngine.playFaultAlarm(fault.type);
  if (fault.type === "oxygen") startOxygenDrain();
}

let oxygenDrainHandle = null;
function startOxygenDrain() {
  stopOxygenDrain();
  oxygenDrainHandle = setInterval(() => {
    if (!state.hardwareFault || state.hardwareFault.type !== "oxygen") { stopOxygenDrain(); return; }
    applyEffects({ sanity: -OXYGEN_DRAIN_AMOUNT });
    updateHUD();
    const endingKey = checkEnding();
    if (endingKey) {
      stopOxygenDrain();
      triggerEnding(endingKey);
    }
  }, OXYGEN_DRAIN_INTERVAL_MS);
}
function stopOxygenDrain() {
  if (oxygenDrainHandle) { clearInterval(oxygenDrainHandle); oxygenDrainHandle = null; }
}

let repairHoldHandle = null;
let repairHoldStartedAt = 0;
function repairTick() {
  if (!state.hardwareFault) { cancelRepairHold(); return; }
  const elapsed = Date.now() - repairHoldStartedAt;
  const pct = Math.min(100, (elapsed / REPAIR_HOLD_MS) * 100);
  els.repairFill.style.width = pct + "%";
  if (pct >= 100) {
    completeRepair();
    return;
  }
  repairHoldHandle = requestAnimationFrame(repairTick);
}
function onRepairPointerDown(e) {
  if (!state.hardwareFault) return;
  e.preventDefault();
  e.stopPropagation();
  repairHoldStartedAt = Date.now();
  els.repairBtn.classList.add("holding");
  if (repairHoldHandle) cancelAnimationFrame(repairHoldHandle);
  repairHoldHandle = requestAnimationFrame(repairTick);
}
function cancelRepairHold() {
  if (repairHoldHandle) { cancelAnimationFrame(repairHoldHandle); repairHoldHandle = null; }
  els.repairBtn.classList.remove("holding");
  if (state.hardwareFault) els.repairFill.style.width = "0%";
}
function completeRepair() {
  cancelRepairHold();
  stopOxygenDrain();
  AudioEngine.playRepairSuccessChime();
  vibrate(60);
  state.hardwareFault = null;
  els.hardwareFault.hidden = true;
  els.cardStage.classList.remove("fault-active");
  advanceToNextCard();
}
function bindHardwareFaultEvents() {
  els.repairBtn.addEventListener("pointerdown", onRepairPointerDown);
  els.repairBtn.addEventListener("pointerup", cancelRepairHold);
  els.repairBtn.addEventListener("pointercancel", cancelRepairHold);
  els.repairBtn.addEventListener("pointerleave", cancelRepairHold);
}

function completeTuning(success) {
  const t = state.tuning;
  if (!t) return;
  const resultId = success ? t.successCardId : t.failureCardId;
  stopTuning();
  els.choices.hidden = false;
  els.tuner.hidden = true;

  if (success) {
    AudioEngine.playSignalLockedChime();
    vibrate(60);
  } else {
    AudioEngine.playFrequencyBurstFail();
    vibrate([40, 40, 40]);
    els.card.classList.add("tune-fail");
    setTimeout(() => els.card.classList.remove("tune-fail"), 550);
  }

  state.day += 1;
  updateNightShift();
  updateHUD();

  const endingKey = checkEnding();
  if (endingKey) {
    triggerEnding(endingKey);
    return;
  }
  state.forcedNextId = resultId;
  advanceToNextCard();
}

/* Kadran sürükleme (mouse + touch, tek API) */
function onTunerPointerDown(e) {
  if (!state.tuning) return;
  e.stopPropagation();
  tuningDragging = true;
  try { els.tunerTrack.setPointerCapture(e.pointerId); } catch (err) { /* yoksay */ }
  updateFreqFromPointer(e);
}
function onTunerPointerMove(e) {
  if (!tuningDragging) return;
  e.stopPropagation();
  updateFreqFromPointer(e);
}
function onTunerPointerUp(e) {
  tuningDragging = false;
}
function updateFreqFromPointer(e) {
  if (!state.tuning) return;
  const rect = els.tunerTrack.getBoundingClientRect();
  const ratio = clampNum((e.clientX - rect.left) / rect.width, 0, 1);
  state.tuning.currentFreq = TUNE_MIN_FREQ + ratio * (TUNE_MAX_FREQ - TUNE_MIN_FREQ);
  updateTunerUI();
}
function bindTunerEvents() {
  els.tunerTrack.addEventListener("pointerdown", onTunerPointerDown);
  els.tunerTrack.addEventListener("pointermove", onTunerPointerMove);
  els.tunerTrack.addEventListener("pointerup", onTunerPointerUp);
  els.tunerTrack.addEventListener("pointercancel", onTunerPointerUp);
}

/* ---------- HUD / göstergeler (segmentli LED bar) ---------- */
const METER_SEGMENT_COUNT = 10;
const METER_CRITICAL_THRESHOLD = 20;

function buildSegmentBars() {
  document.querySelectorAll(".segment-bar").forEach((bar) => {
    bar.innerHTML = "";
    for (let i = 0; i < METER_SEGMENT_COUNT; i++) {
      const seg = document.createElement("span");
      seg.className = "segment";
      bar.appendChild(seg);
    }
  });
}

function setSegmentValue(meterKey, value) {
  const barEl = els.meters[meterKey].querySelector(".segment-bar");
  const segments = barEl.children;
  const litCount = Math.round((clamp(value) / STATS_MAX) * METER_SEGMENT_COUNT);
  for (let i = 0; i < segments.length; i++) {
    segments[i].classList.toggle("lit", i < litCount);
  }
  barEl.classList.toggle("critical", value < METER_CRITICAL_THRESHOLD);
}

function setMeterWidths() {
  setSegmentValue("power", state.power);
  setSegmentValue("trust", state.trust);
  setSegmentValue("sanity", state.sanity);
  setSegmentValue("signal", state.signal);
}

function clearSegmentsVisual(meterKey) {
  const barEl = els.meters[meterKey].querySelector(".segment-bar");
  Array.from(barEl.children).forEach((seg) => seg.classList.remove("lit"));
}

function updateHUD() {
  els.day.textContent = `GÜN ${state.day}`;
  els.tape.textContent = `BANT #${String(state.tapeNumber).padStart(3, "0")}: ${STORY_META.operatorName}`;
  if (!meterBlackoutActive) setMeterWidths();
  updateGlitchLevel();
  els.statReadout.power.textContent = Math.round(state.power);
  els.statReadout.trust.textContent = Math.round(state.trust);
  els.statReadout.sanity.textContent = Math.round(state.sanity);
  els.statReadout.signal.textContent = Math.round(state.signal);
}

/* Akıl kritikken göstergeler 1-1.5sn için sıfıra düşüp geri dönüyor — oyuncu hangi kaynağın
   tükendiğini bir an için kaybediyor. Gerçek state'e dokunmaz, sadece görsel. */
let meterBlackoutActive = false;
function maybeBlackoutMeters() {
  if (state.sanity >= 25 || meterBlackoutActive || state.ended) return;
  if (Math.random() >= 0.06) return;
  meterBlackoutActive = true;
  clearSegmentsVisual("power");
  clearSegmentsVisual("trust");
  clearSegmentsVisual("sanity");
  clearSegmentsVisual("signal");
  setTimeout(() => {
    meterBlackoutActive = false;
    setMeterWidths();
  }, 1200 + Math.random() * 500);
}

function updateGlitchLevel() {
  const corruption = Math.max(state.signal, STATS_MAX - state.sanity);
  const root = document.documentElement;
  root.classList.remove("glitch-level-1", "glitch-level-2", "glitch-level-3");
  if (corruption >= 75) root.classList.add("glitch-level-3");
  else if (corruption >= 50) root.classList.add("glitch-level-2");
  else if (corruption >= 25) root.classList.add("glitch-level-1");
  root.classList.toggle("sanity-crisis", state.sanity < SANITY_CRISIS_THRESHOLD && !state.ended);
}

/* ---------- Akıl düştükçe metin bozulması ---------- */
function corruptText(str, intensity) {
  const chars = str.split("");
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === " " || chars[i] === "“" || chars[i] === "”") continue;
    if (Math.random() < intensity) {
      chars[i] = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
    }
  }
  return chars.join("");
}

function corruptionActive() {
  return state.sanity < 25 || state.signal > 75;
}

const HALLUCINATION_PHRASES = ["BURADA DEĞİLSİN", "KAPIYI AÇ", "YALAN SÖYLÜYOR"];
let hallucinationUntil = 0;

function refreshGlitchTextLoop() {
  if (glitchTextHandle) clearInterval(glitchTextHandle);
  glitchTextHandle = setInterval(() => {
    if (state.ended || state.hardwareFault) return;
    maybeBlackoutMeters();
    const card = DECK.find((c) => c.id === state.currentCardId);
    if (!card || card.type === "memory_letter") return; // ham {{...}} metni sızdırmasın, panel kendi çizimini yönetir

    if (Date.now() < hallucinationUntil) return; // sanrı hâlâ ekranda, bu tick'te dokunma

    // 4. Duvarı Kıran Delirme Sanrısı: Akıl <20 iken metin anlık olarak tekinsiz bir fısıltıya dönüşür.
    if (state.sanity < 20 && Math.random() < 0.25) {
      const phrase = HALLUCINATION_PHRASES[Math.floor(Math.random() * HALLUCINATION_PHRASES.length)];
      els.quoteText.textContent = phrase;
      els.quoteText.classList.add("hallucinating");
      hallucinationUntil = Date.now() + 1200;
      setTimeout(() => els.quoteText.classList.remove("hallucinating"), 1200);
      return;
    }

    if (state.sanity < 25 && card.glitchText) {
      // Elle yazılmış, anlamlı çöküş varyantı (tekrar/ters okuma vb.) — jenerik bozulmadan önce gelir.
      els.quoteText.textContent = card.glitchText;
    } else if (state.sanity < 30) {
      const intensity = (30 - state.sanity) / 60; // sanity 0 -> ~0.5, sanity 29 -> ~0.017
      els.quoteText.textContent = corruptText(state.currentTrueText, intensity);
    } else if (state.sanity < SANITY_CRISIS_THRESHOLD) {
      // Akıl 30-35 arası: erken uyarı — kelimeler nadiren anlık olarak zalgo'ya dönüp 400ms'de geri gelir.
      if (Math.random() < 0.3) maybeFlickerWord();
      else els.quoteText.textContent = state.currentTrueText;
    } else {
      els.quoteText.textContent = state.currentTrueText;
    }

    if (state.sanity < SANITY_CRISIS_THRESHOLD && Math.random() < 0.15) {
      AudioEngine.playMicroWhisper();
    }

    if (card.type !== "radio_tune") {
      const useLeftGlitch = state.sanity < 25 && card.left.glitchLabel;
      const useRightGlitch = state.sanity < 25 && card.right.glitchLabel;
      els.leftLabel.textContent = useLeftGlitch ? card.left.glitchLabel : card.left.label;
      els.rightLabel.textContent = useRightGlitch ? card.right.glitchLabel : card.right.label;
    }
  }, 900);
}

/* ---------- Etki uygulama ---------- */
const NIGHT_EFFECT_MULT = 1.25; // Gece Vardiyası: Akıl/Sinyal etkileri %25 daha sert

function applyEffects(effects) {
  if (!effects) return;
  const mult = state.isNight ? NIGHT_EFFECT_MULT : 1;
  if (typeof effects.power === "number") state.power = clamp(state.power + effects.power);
  if (typeof effects.trust === "number") state.trust = clamp(state.trust + effects.trust);
  if (typeof effects.sanity === "number") state.sanity = clamp(state.sanity + effects.sanity * mult);
  if (typeof effects.signal === "number") state.signal = clamp(state.signal + effects.signal * mult);
  if (effects.rel) {
    Object.entries(effects.rel).forEach(([key, delta]) => {
      const current = state.relationships[key] ?? 50;
      state.relationships[key] = clamp(current + delta);
    });
  }
}

/* ---------- Sonlar: her göstergenin iki ucu da ayrı bir son ---------- */
const ENDINGS = {
  power_zero: {
    title: "KARANLIK",
    body: "Jeneratör son kez öksürüp susuyor. Dışarısı içeri sızıyor. Karanlıkta, arkandan gelen bir nefes sesi duyuyorsun — senin değil.",
    logLine: "Jeneratör sustu, operatör karanlıkta kayboldu.",
  },
  power_max: {
    title: "AŞIRI YÜK",
    body: "Türbin dayanamıyor. Bir patlama, sonra beyaz bir ışık. Son bandın, kendi çığlığınla bitiyor.",
    logLine: "Aşırı yüklenme vericiyi ve operatörü birlikte götürdü.",
  },
  trust_zero: {
    title: "TERK EDİLDİN",
    body: "Kimse cevap vermiyor artık. Frekansın hâlâ açık ama karşında sadece soğuk statik var. Kimse gelmeyecek.",
    logLine: "Kimse cevap vermedi, operatör sessizlikte terk edildi.",
  },
  trust_max: {
    title: "KURBAN SONU",
    body: "Kapı kırılıyor. İçeri girenler seni kurtarmaya gelmedi. Mucizevi sesi susturmamak için seni konsola bağlıyorlar.",
    logLine: "Dinleyiciler operatörü konsola bağladı, yayın onlar için sürüyor artık.",
  },
  sanity_zero: {
    title: "PARANOYA",
    body: "Kart seçenekleri yer değiştiriyor, harfler tersine dönüyor. Kendi elin, kendi iradenle, vericiyi havaya uçuruyor.",
    logLine: "Frekanstaki fısıltılar operatörün zihnini tüketti.",
  },
  sanity_max: {
    title: "HİSSİZLİK",
    body: "Artık hiçbir şey hissetmiyorsun. Yayın konuşmasız, tepkisiz sürüyor — ta ki biri, çok sonra, sessizliği fark edene kadar.",
    logLine: "Operatör artık hiçbir şey hissetmiyor, yayın anlamını yitirdi.",
  },
  signal_zero: {
    title: "SESSİZLİK SONU",
    body: "88.4 MHz artık sadece boşluk. Frekans, hiç var olmamış gibi, tamamen ölüyor.",
    logLine: "88.4 MHz sonsuza dek sustu.",
  },
  signal_max: {
    title: "REZONANS SONU",
    body: "Mikrofonu açıyorsun ama çıkan ses senin değil. Bütün vadi, aynı anda, sonsuza kadar susuyor.",
    logLine: "Varlık operatörün sesini ele geçirdi, yayın artık onun.",
  },
  true_escape: {
    title: "GERÇEK KAÇIŞ",
    body: "Kapı açılıyor. Nükleer kış hâlâ sürüyor olsa da, artık bir sığınak-mahkûmu değilsin. Hafızan geri geldi ve seni buraya getiren gerçek de. Frekans burada bitiyor — ama sen bitmiyorsun.",
    logLine: "Operatör hafızasını tamamen geri kazandı ve sığınaktan gerçek anlamda kaçtı.",
  },
};

function checkEnding() {
  if (state.power <= 0) return "power_zero";
  if (state.power >= 100) return "power_max";
  if (state.trust <= 0) return "trust_zero";
  if (state.trust >= 100) return "trust_max";
  if (state.sanity <= 0) return "sanity_zero";
  if (state.sanity >= 100) return "sanity_max";
  if (state.signal <= 0) return "signal_zero";
  if (state.signal >= 100) return "signal_max";
  return null;
}

/* ---------- Prosedürel kaset çıkarma sesi (Web Audio, dosya yok) ---------- */
/* ---------- Analog ambiyans motoru (saf Web Audio API, harici dosya yok) ---------- */
const MENU_TRACK_URL = "audio/menu.mp3";
const GAMEPLAY_TRACK_URL = "audio/gameplay.mp3";
const MENU_VOLUME = 0.35;
const GAMEPLAY_VOLUME = 0.30;

const AudioEngine = (() => {
  let ctx = null;
  let crackleSource = null;
  let crackleFilter = null;
  let crackleGain = null;
  const bufferCache = {}; // url -> { promise, failed }

  // Ses ayarları paneli: Ana Ses / Müzik / Telsiz-SFX bus'ları — kalıcı, localStorage'dan okunur.
  let masterVolume = loadSetting("sonFrekansMasterVolume", 1);
  let musicVolume = loadSetting("sonFrekansMusicVolume", 1);
  let sfxVolume = loadSetting("sonFrekansSfxVolume", 1);
  let masterGain = null;
  let musicBus = null;
  let sfxBus = null;

  // Menü/intro müziği (audio/menu.mp3)
  let menuSource = null;
  let menuGain = null;

  // Oyun içi müzik (audio/gameplay.mp3)
  let gameSource = null;
  let gameFilter = null;
  let gamePanner = null;
  let gameGain = null;
  let wobbleLFO = null;
  let wobbleDepthGain = null;
  let gameplayDead = false;

  // Sinyal >%70: uzak çınlama + fısıltı katmanı
  let ringOsc = null;
  let ringGain = null;
  let whisperSource = null;
  let whisperGain = null;

  // Tuner mini-oyunu: boş frekans gürültüsü + yaklaşınca netleşen mors/fısıltı
  let tunerNoiseSource = null;
  let tunerNoiseFilter = null;
  let tunerNoiseGain = null;
  let tunerMorseOsc = null;
  let tunerMorseGain = null;
  let tunerMorseHandle = null;

  function makeNoiseBuffer(seconds) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function ensure() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      masterGain = ctx.createGain();
      masterGain.gain.value = masterVolume;
      masterGain.connect(ctx.destination);

      musicBus = ctx.createGain();
      musicBus.gain.value = musicVolume;
      musicBus.connect(masterGain);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = sfxVolume;
      sfxBus.connect(masterGain);

      // 50 Hz trafo humu — çok derinden gelen analog zemin.
      const hum = ctx.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 50;
      const humGain = ctx.createGain();
      humGain.gain.value = 0.02;
      hum.connect(humGain).connect(sfxBus);
      hum.start();

      // Filtrelenmiş statik zemin (beyaz gürültü + alçak geçiren filtre).
      const noise = ctx.createBufferSource();
      noise.buffer = makeNoiseBuffer(2);
      noise.loop = true;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "lowpass";
      noiseFilter.frequency.value = 90;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.012;
      noise.connect(noiseFilter).connect(noiseGain).connect(sfxBus);
      noise.start();
    } catch (e) {
      /* Web Audio kullanılamıyorsa sessizce geç */
    }
    startMenuMusic();
  }

  function setMasterVolume(v) {
    masterVolume = clampNum(v, 0, 1);
    saveSetting("sonFrekansMasterVolume", masterVolume);
    if (ctx && masterGain) masterGain.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.05);
  }
  function setMusicVolume(v) {
    musicVolume = clampNum(v, 0, 1);
    saveSetting("sonFrekansMusicVolume", musicVolume);
    if (ctx && musicBus) musicBus.gain.setTargetAtTime(musicVolume, ctx.currentTime, 0.05);
  }
  function setSfxVolume(v) {
    sfxVolume = clampNum(v, 0, 1);
    saveSetting("sonFrekansSfxVolume", sfxVolume);
    if (ctx && sfxBus) sfxBus.gain.setTargetAtTime(sfxVolume, ctx.currentTime, 0.05);
  }
  function getVolumes() {
    return { master: masterVolume, music: musicVolume, sfx: sfxVolume };
  }

  function loadBuffer(url) {
    if (!bufferCache[url]) {
      bufferCache[url] = fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error("track not found: " + url);
          return res.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => null); // dosya henüz eklenmemiş olabilir — sessizce geç
    }
    return bufferCache[url];
  }

  /* ---------- Menü/intro müziği ---------- */
  function startMenuMusic() {
    if (!ctx || menuSource) return;
    loadBuffer(MENU_TRACK_URL).then((buffer) => {
      if (!buffer || menuSource) return;
      try {
        menuSource = ctx.createBufferSource();
        menuSource.buffer = buffer;
        menuSource.loop = true;
        menuGain = ctx.createGain();
        menuGain.gain.value = 0;
        menuSource.connect(menuGain).connect(musicBus);
        menuSource.start();
        menuGain.gain.setTargetAtTime(MENU_VOLUME, ctx.currentTime, 0.8);
      } catch (e) {
        /* yoksay */
      }
    });
  }

  function stopMenuMusic() {
    if (!ctx || !menuGain) return;
    menuGain.gain.setTargetAtTime(0, ctx.currentTime, 1); // 1sn fade-out
    const src = menuSource;
    menuSource = null;
    menuGain = null;
    setTimeout(() => {
      try { src && src.stop(); } catch (e) { /* yoksay */ }
    }, 1200);
  }

  /* ---------- Oyun içi müzik (Akıl'a göre boğulan kaset katmanı) ---------- */
  function startGameplayMusic() {
    if (!ctx) return;
    gameplayDead = false;
    loadBuffer(GAMEPLAY_TRACK_URL).then((buffer) => {
      if (!buffer || gameSource) return;
      try {
        gameSource = ctx.createBufferSource();
        gameSource.buffer = buffer;
        gameSource.loop = true;

        gameFilter = ctx.createBiquadFilter();
        gameFilter.type = "lowpass";
        gameFilter.frequency.value = 20000; // Akıl tam iken filtre tamamen açık

        gamePanner = ctx.createStereoPanner();
        gamePanner.pan.value = 0;

        gameGain = ctx.createGain();
        gameGain.gain.value = 0; // 0'dan gerçek hedefe (0.30) yumuşak fade-in

        // Bozuk kaset sarma efekti: yavaş bir LFO, detune parametresini salınımla besliyor.
        wobbleLFO = ctx.createOscillator();
        wobbleLFO.type = "sine";
        wobbleLFO.frequency.value = 0.22;
        wobbleDepthGain = ctx.createGain();
        wobbleDepthGain.gain.value = 0; // Akıl düştükçe büyür
        wobbleLFO.connect(wobbleDepthGain).connect(gameSource.detune);
        wobbleLFO.start();

        gameSource.connect(gameFilter).connect(gamePanner).connect(gameGain).connect(musicBus);
        gameSource.start();
        gameGain.gain.setTargetAtTime(GAMEPLAY_VOLUME, ctx.currentTime, 1);
      } catch (e) {
        /* yoksay */
      }
    });
  }

  function ensureWhisperLayer() {
    if (ringOsc || !ctx) return;
    try {
      ringOsc = ctx.createOscillator();
      ringOsc.type = "sine";
      ringOsc.frequency.value = 1200;
      const ringPanner = ctx.createStereoPanner();
      ringPanner.pan.value = 0.8;
      ringGain = ctx.createGain();
      ringGain.gain.value = 0;
      ringOsc.connect(ringPanner).connect(ringGain).connect(sfxBus);
      ringOsc.start();

      whisperSource = ctx.createBufferSource();
      whisperSource.buffer = makeNoiseBuffer(2);
      whisperSource.loop = true;
      const whisperFilter = ctx.createBiquadFilter();
      whisperFilter.type = "highpass";
      whisperFilter.frequency.value = 5000;
      const whisperPanner = ctx.createStereoPanner();
      whisperPanner.pan.value = 0.8;
      whisperGain = ctx.createGain();
      whisperGain.gain.value = 0;
      whisperSource.connect(whisperFilter).connect(whisperPanner).connect(whisperGain).connect(sfxBus);
      whisperSource.start();
    } catch (e) {
      /* yoksay */
    }
  }

  function updateForState(sanity, signal) {
    if (!ctx || gameplayDead) return;
    const t = ctx.currentTime;

    if (gameFilter) {
      const freq = 200 + (sanity / 100) * 19800; // Akıl 0 -> 200Hz (boğuk), 100 -> 20000Hz (açık)
      gameFilter.frequency.setTargetAtTime(freq, t, 0.6);
    }
    if (wobbleDepthGain) {
      const wobbleDepth = ((100 - sanity) / 100) * 38; // cent cinsinden detune salınım derinliği
      wobbleDepthGain.gain.setTargetAtTime(wobbleDepth, t, 0.6);
    }

    if (signal > 70) {
      ensureWhisperLayer();
      if (ringGain) ringGain.gain.setTargetAtTime(0.02, t, 0.8);
      if (whisperGain) whisperGain.gain.setTargetAtTime(0.014, t, 0.8);
    } else {
      if (ringGain) ringGain.gain.setTargetAtTime(0, t, 0.8);
      if (whisperGain) whisperGain.gain.setTargetAtTime(0, t, 0.8);
    }
  }

  function onEnding() {
    if (!ctx || !gameSource || gameplayDead) return;
    gameplayDead = true;
    const t = ctx.currentTime;
    try {
      gameSource.playbackRate.cancelScheduledValues(t);
      gameSource.playbackRate.setValueAtTime(gameSource.playbackRate.value, t);
      gameSource.playbackRate.linearRampToValueAtTime(0.1, t + 1.3); // teyp elektriği kesilmiş gibi yavaşlar
      if (gameFilter) gameFilter.frequency.setTargetAtTime(120, t, 0.35);
      if (gameGain) gameGain.gain.setTargetAtTime(0, t + 0.15, 0.4);
      if (ringGain) ringGain.gain.setTargetAtTime(0, t, 0.2);
      if (whisperGain) whisperGain.gain.setTargetAtTime(0, t, 0.2);
      const src = gameSource;
      gameSource = null;
      setTimeout(() => {
        try { src.stop(); } catch (e) { /* yoksay */ }
      }, 1500);
    } catch (e) {
      /* yoksay */
    }
  }

  function onRestart() {
    // Bir önceki koşunun oyun-içi müziği onEnding() ile zaten sessizleşip durduruldu.
    // Yeni koşu menü müziğiyle baştan başlar; gameplay müziği intro bitince taze bir
    // kaynakla (startGameplayMusic) yeniden kurulur.
    gameplayDead = false;
    startMenuMusic();
  }

  function startCrackle() {
    ensure();
    if (!ctx || crackleSource) return;
    try {
      crackleSource = ctx.createBufferSource();
      crackleSource.buffer = makeNoiseBuffer(1);
      crackleSource.loop = true;
      crackleFilter = ctx.createBiquadFilter();
      crackleFilter.type = "bandpass";
      crackleFilter.frequency.value = 600;
      crackleFilter.Q.value = 1.2;
      crackleGain = ctx.createGain();
      crackleGain.gain.value = 0;
      crackleSource.connect(crackleFilter).connect(crackleGain).connect(sfxBus);
      crackleSource.start();
    } catch (e) {
      /* yoksay */
    }
  }

  function updateCrackle(dxAbs) {
    if (!ctx || !crackleGain) return;
    const t = ctx.currentTime;
    crackleFilter.frequency.setTargetAtTime(500 + dxAbs * 9, t, 0.05);
    crackleGain.gain.setTargetAtTime(Math.min(0.05, dxAbs / 2200), t, 0.05);
  }

  function stopCrackle() {
    if (!ctx || !crackleGain) return;
    crackleGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    const src = crackleSource;
    crackleSource = null;
    setTimeout(() => {
      try { src && src.stop(); } catch (e) { /* yoksay */ }
    }, 400);
  }

  function playClick() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = "square";
    click.frequency.setValueAtTime(320, now);
    clickGain.gain.setValueAtTime(0.14, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    click.connect(clickGain).connect(sfxBus);
    click.start(now);
    click.stop(now + 0.06);
  }

  function playEjectSound() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;

    // mekanik "klik"
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = "square";
    click.frequency.setValueAtTime(180, now);
    clickGain.gain.setValueAtTime(0.25, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    click.connect(clickGain).connect(sfxBus);
    click.start(now);
    click.stop(now + 0.09);

    // motor "vınlama" düşüşü
    const whirr = ctx.createOscillator();
    const whirrGain = ctx.createGain();
    whirr.type = "sawtooth";
    whirr.frequency.setValueAtTime(220, now + 0.1);
    whirr.frequency.exponentialRampToValueAtTime(60, now + 0.6);
    whirrGain.gain.setValueAtTime(0.001, now + 0.1);
    whirrGain.gain.linearRampToValueAtTime(0.12, now + 0.15);
    whirrGain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
    whirr.connect(whirrGain).connect(sfxBus);
    whirr.start(now + 0.1);
    whirr.stop(now + 0.7);
  }

  function playDoorCreak() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Gerilen menteşe: yavaş perde kayması, bant-geçirgen filtreyle metalik rezonans.
    const creak = ctx.createOscillator();
    creak.type = "sawtooth";
    creak.frequency.setValueAtTime(140, now);
    creak.frequency.linearRampToValueAtTime(90, now + 0.6);
    creak.frequency.linearRampToValueAtTime(160, now + 1.3);
    const creakFilter = ctx.createBiquadFilter();
    creakFilter.type = "bandpass";
    creakFilter.frequency.value = 300;
    creakFilter.Q.value = 4;
    const creakGain = ctx.createGain();
    creakGain.gain.setValueAtTime(0, now);
    creakGain.gain.linearRampToValueAtTime(0.05, now + 0.15);
    creakGain.gain.linearRampToValueAtTime(0.02, now + 0.9);
    creakGain.gain.linearRampToValueAtTime(0, now + 1.4);
    creak.connect(creakFilter).connect(creakGain).connect(sfxBus);
    creak.start(now);
    creak.stop(now + 1.45);

    // Metal sürtünme dokusu: yüksek geçirgen filtreli kısa gürültü katmanı.
    const scrape = ctx.createBufferSource();
    scrape.buffer = makeNoiseBuffer(1.4);
    const scrapeFilter = ctx.createBiquadFilter();
    scrapeFilter.type = "highpass";
    scrapeFilter.frequency.value = 2200;
    const scrapeGain = ctx.createGain();
    scrapeGain.gain.setValueAtTime(0, now);
    scrapeGain.gain.linearRampToValueAtTime(0.012, now + 0.2);
    scrapeGain.gain.linearRampToValueAtTime(0, now + 1.2);
    scrape.connect(scrapeFilter).connect(scrapeGain).connect(sfxBus);
    scrape.start(now);
    scrape.stop(now + 1.3);
  }

  function playHoverStatic() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(0.2);
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 3500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.02, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    noise.connect(filter).connect(gain).connect(sfxBus);
    noise.start(now);
    noise.stop(now + 0.16);
  }

  function playTapeInsert() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;

    const click = ctx.createOscillator();
    click.type = "square";
    click.frequency.setValueAtTime(200, now);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.22, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    click.connect(clickGain).connect(sfxBus);
    click.start(now);
    click.stop(now + 0.08);

    // Motor yükseliyor: eject'in tersi — kaset okumaya başlıyor.
    const spinUp = ctx.createOscillator();
    spinUp.type = "sawtooth";
    spinUp.frequency.setValueAtTime(50, now + 0.08);
    spinUp.frequency.exponentialRampToValueAtTime(240, now + 0.55);
    const spinGain = ctx.createGain();
    spinGain.gain.setValueAtTime(0.001, now + 0.08);
    spinGain.gain.linearRampToValueAtTime(0.11, now + 0.2);
    spinGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    spinUp.connect(spinGain).connect(sfxBus);
    spinUp.start(now + 0.08);
    spinUp.stop(now + 0.65);
  }

  /* ---------- Tuner mini-oyunu ---------- */
  function startTunerNoise() {
    ensure();
    if (!ctx || tunerNoiseSource) return;
    tunerNoiseSource = ctx.createBufferSource();
    tunerNoiseSource.buffer = makeNoiseBuffer(2);
    tunerNoiseSource.loop = true;
    tunerNoiseFilter = ctx.createBiquadFilter();
    tunerNoiseFilter.type = "bandpass";
    tunerNoiseFilter.frequency.value = 2200;
    tunerNoiseFilter.Q.value = 0.6;
    tunerNoiseGain = ctx.createGain();
    tunerNoiseGain.gain.value = 0.09;
    tunerNoiseSource.connect(tunerNoiseFilter).connect(tunerNoiseGain).connect(sfxBus);
    tunerNoiseSource.start();

    tunerMorseOsc = ctx.createOscillator();
    tunerMorseOsc.type = "sine";
    tunerMorseOsc.frequency.value = 620;
    tunerMorseGain = ctx.createGain();
    tunerMorseGain.gain.value = 0;
    tunerMorseOsc.connect(tunerMorseGain).connect(sfxBus);
    tunerMorseOsc.start();

    // Basit mors-vari titreşim: yakınlıkla orantılı hedef seviyeye rastgele dit/dah döngüsüyle yaklaşır.
    let morseTarget = 0;
    tunerMorseHandle = setInterval(() => {
      if (!ctx || !tunerMorseGain) return;
      const t = ctx.currentTime;
      const on = Math.random() < 0.55;
      tunerMorseGain.gain.setTargetAtTime(on ? morseTarget : 0, t, 0.03);
    }, 190);
    tunerMorseOsc._setTarget = (v) => { morseTarget = v; };
  }

  function updateTunerNoise(distance) {
    // distance: 0 (hedefin tam üstünde) .. 1 (kadranın en uzak ucu)
    if (!ctx || !tunerNoiseGain) return;
    const t = ctx.currentTime;
    tunerNoiseGain.gain.setTargetAtTime(0.02 + distance * 0.09, t, 0.15);
    tunerNoiseFilter.frequency.setTargetAtTime(1200 + distance * 2600, t, 0.15);
    if (tunerMorseOsc && tunerMorseOsc._setTarget) tunerMorseOsc._setTarget((1 - distance) * 0.06);
  }

  function stopTunerNoise() {
    if (tunerMorseHandle) { clearInterval(tunerMorseHandle); tunerMorseHandle = null; }
    try { tunerNoiseSource && tunerNoiseSource.stop(); } catch (e) { /* yoksay */ }
    try { tunerMorseOsc && tunerMorseOsc.stop(); } catch (e) { /* yoksay */ }
    tunerNoiseSource = null;
    tunerMorseOsc = null;
    tunerNoiseGain = null;
    tunerMorseGain = null;
  }

  function playSignalLockedChime() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    [660, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.11;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain).connect(sfxBus);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  }

  /* ---------- Hafıza Mektupları: Zihin Eşleme başarıyla kilitlenince sıcak, yükselen bir "içgörü" akoru ---------- */
  function playMemoryRevealChime() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    [440, 554, 659, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
      osc.connect(gain).connect(sfxBus);
      osc.start(start);
      osc.stop(start + 0.6);
    });
  }

  function playFrequencyBurstFail() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const burst = ctx.createBufferSource();
    burst.buffer = makeNoiseBuffer(0.5);
    const burstFilter = ctx.createBiquadFilter();
    burstFilter.type = "lowpass";
    burstFilter.frequency.value = 800;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.22, now);
    burstGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    burst.connect(burstFilter).connect(burstGain).connect(sfxBus);
    burst.start(now);
    burst.stop(now + 0.5);

    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(90, now);
    thud.frequency.exponentialRampToValueAtTime(30, now + 0.3);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.2, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    thud.connect(thudGain).connect(sfxBus);
    thud.start(now);
    thud.stop(now + 0.36);
  }

  /* ---------- Akıl Çöküşü: mikro fısıltı/frekans çatlaması (arka planda rastgele) ---------- */
  function playMicroWhisper() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(0.4);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800 + Math.random() * 1400;
    filter.Q.value = 3.2;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.random() * 2 - 1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    src.connect(filter).connect(panner).connect(gain).connect(sfxBus);
    src.start(now);
    src.stop(now + 0.4);
  }

  /* ---------- Sığınak Donanım Arızası: alarm bipi ---------- */
  function playFaultAlarm(type) {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const freq = type === "oxygen" ? 520 : 720;
    [0, 1].forEach((i) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.22;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.connect(gain).connect(sfxBus);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  }

  function playRepairSuccessChime() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    [520, 780, 1040].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.connect(gain).connect(sfxBus);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  }

  /* ---------- Buse Canlı Telsiz Frekansı: gizli kanal keşfi ---------- */
  function playBuseSecretSting() {
    ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const morse = ctx.createOscillator();
    morse.type = "sine";
    morse.frequency.value = 900;
    const morseGain = ctx.createGain();
    [0, 0.12, 0.24, 0.44].forEach((t, i) => {
      const start = now + t;
      const dur = i === 3 ? 0.18 : 0.08;
      morseGain.gain.setValueAtTime(0, start);
      morseGain.gain.linearRampToValueAtTime(0.08, start + 0.01);
      morseGain.gain.linearRampToValueAtTime(0, start + dur);
    });
    morse.connect(morseGain).connect(sfxBus);
    morse.start(now);
    morse.stop(now + 0.7);

    const swoosh = ctx.createBufferSource();
    swoosh.buffer = makeNoiseBuffer(0.6);
    const swooshFilter = ctx.createBiquadFilter();
    swooshFilter.type = "bandpass";
    swooshFilter.frequency.setValueAtTime(300, now);
    swooshFilter.frequency.exponentialRampToValueAtTime(3000, now + 0.6);
    swooshFilter.Q.value = 0.8;
    const swooshGain = ctx.createGain();
    swooshGain.gain.setValueAtTime(0.001, now);
    swooshGain.gain.linearRampToValueAtTime(0.05, now + 0.2);
    swooshGain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
    swoosh.connect(swooshFilter).connect(swooshGain).connect(sfxBus);
    swoosh.start(now);
    swoosh.stop(now + 0.66);
  }

  return {
    ensure,
    startCrackle,
    updateCrackle,
    stopCrackle,
    playClick,
    playEjectSound,
    playDoorCreak,
    playHoverStatic,
    playTapeInsert,
    startTunerNoise,
    updateTunerNoise,
    stopTunerNoise,
    playSignalLockedChime,
    playFrequencyBurstFail,
    playMicroWhisper,
    playFaultAlarm,
    playRepairSuccessChime,
    playBuseSecretSting,
    playMemoryRevealChime,
    startMenuMusic,
    stopMenuMusic,
    startGameplayMusic,
    updateForState,
    onEnding,
    onRestart,
    setMasterVolume,
    setMusicVolume,
    setSfxVolume,
    getVolumes,
  };
})();

function triggerEnding(key) {
  state.ended = true;
  AudioEngine.ensure();
  if (glitchTextHandle) clearInterval(glitchTextHandle);
  els.quoteText.textContent = state.currentTrueText;

  const ending = ENDINGS[key];
  els.endingTitle.textContent = ending.title;
  els.endingBody.textContent = ending.body;
  els.endingStats.textContent = `Bant #${String(state.tapeNumber).padStart(3, "0")} — ${state.day}. gün: ${ending.logLine}`;

  const discovered = loadDiscoveredEndings();
  discovered.add(key);
  saveDiscoveredEndings(discovered);
  if (state.day > loadHighScoreDay()) saveHighScoreDay(state.day);
  els.archiveLineEnding.textContent = formatArchiveLine();
  clearGameProgress(); // yayın bitti, artık "devam edilecek" bir oturum yok

  els.card.classList.add("tape-eject");
  AudioEngine.playEjectSound();
  AudioEngine.onEnding();
  setTimeout(() => {
    els.endingOverlay.classList.add("show");
  }, 450);
}

function resolveChoice(side) {
  if (state.ended) return; // savunma: gerçek girdi zaten pointer/klavye katmanında engelleniyor
  if (state.showingIntro) {
    state.showingIntro = false;
    state.day = 1;
    updateNightShift();
    AudioEngine.stopMenuMusic();
    AudioEngine.startGameplayMusic();
    renderCard(pickCard());
    return;
  }

  const card = DECK.find((c) => c.id === state.currentCardId);
  const choice = card[side];
  applyEffects(choice.effects);
  // Karakter Dosyası: Ceylan'ın kalma/gitme kararı bu tek karttan netleşir.
  if (card.id === "ceylan_leaving_thought") {
    const fate = side === "right" ? "stayed" : "left";
    state.characterFates.ceylan = fate;
    saveCharacterFate("ceylan", fate);
  }
  if (choice.nextCardId) state.forcedNextId = choice.nextCardId;
  if (choice.scheduleCallback) {
    // Tüm tanımı (id, relKey, variants) taşı — zincirleme callback'ler ve ilişki bazlı
    // varyant seçimi bu sayede due-time'da (resolveCallbackCard) doğru şekilde çözülür.
    state.pendingCallbacks.push({ ...choice.scheduleCallback, remaining: choice.scheduleCallback.after });
  }
  state.pendingCallbacks.forEach((cb) => { cb.remaining -= 1; });
  state.day += 1;
  updateNightShift();
  updateHUD();

  if (choice.triggerEnding) {
    // Anlatı bazlı final (ör. true_escape) — stat eşiği kontrolünü beklemeden doğrudan tetiklenir.
    triggerEnding(choice.triggerEnding);
    return;
  }
  const endingKey = checkEnding();
  if (endingKey) {
    triggerEnding(endingKey);
    return;
  }
  advanceToNextCard();
}

function updateChoiceHighlight(dx) {
  els.choiceLeft.classList.toggle("active", dx < -20);
  els.choiceRight.classList.toggle("active", dx > 20);

  const STAMP_MAX_OPACITY = 0.85;
  const leftAmt = dx < -20 ? Math.min(1, -dx / SWIPE_COMMIT_PX) * STAMP_MAX_OPACITY : 0;
  const rightAmt = dx > 20 ? Math.min(1, dx / SWIPE_COMMIT_PX) * STAMP_MAX_OPACITY : 0;
  els.hintLeft.style.opacity = leftAmt;
  els.hintRight.style.opacity = rightAmt;
  els.stampLeft.style.opacity = leftAmt;
  els.stampRight.style.opacity = rightAmt;

  const card = DECK.find((c) => c.id === state.currentCardId);
  if (card && card.left && card.right) {
    els.stampLeft.textContent = `[ ${card.left.label.toLocaleUpperCase("tr")} ]`;
    els.stampRight.textContent = (dragState && dragState.stampOverride)
      ? dragState.stampOverride
      : `[ ${card.right.label.toLocaleUpperCase("tr")} ]`;
  }

  updateMeterPings(dx);
}

function updateMeterPings(dx) {
  const card = DECK.find((c) => c.id === state.currentCardId);
  const activeKeys = new Set();
  if (card && Math.abs(dx) > 20) {
    const side = dx < 0 ? "left" : "right";
    const effects = card[side].effects || {};
    Object.keys(effects).forEach((key) => activeKeys.add(key));
  }
  Object.entries(METER_SELECTORS).forEach(([key, sel]) => {
    els.meters[key].classList.toggle("ping-active", activeKeys.has(key));
  });
}

/* ---------- Pointer sürükleme fiziği (mouse + touch, tek API) ---------- */
let dragState = null;
const RESIST_CHANCE = 0.3;
const STAMP_HALLUCINATION_CHANCE = 0.2;
const HALLUCINATION_STAMP_PHRASES = ["[ KAÇ ]", "[ YALAN ]"];

function vibrate(ms) {
  try { navigator.vibrate?.(ms); } catch (e) { /* desteklenmiyor, yoksay */ }
}

function onPointerDown(e) {
  if (state.ended || state.tuning || state.hardwareFault || state.memory) return; // Tuner/arıza/Zihin Eşleme açıkken standart kaydırma kilitli
  const activeCard = DECK.find((c) => c.id === state.currentCardId);
  if (activeCard && activeCard.type === "memory_letter") return; // hafıza mektubunda swipe anlamsız
  try { els.card.setPointerCapture(e.pointerId); } catch (err) { /* yakalama başarısız olsa da sürükleme devam eder */ }
  AudioEngine.startCrackle();
  const stampOverride = (state.sanity < 20 && Math.random() < STAMP_HALLUCINATION_CHANCE)
    ? HALLUCINATION_STAMP_PHRASES[Math.floor(Math.random() * HALLUCINATION_STAMP_PHRASES.length)]
    : null;
  dragState = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, resisting: false, resistRolled: false, stampOverride };
  els.card.style.transition = "none";
}

function onPointerMove(e) {
  if (!dragState) return;
  dragState.dx = e.clientX - dragState.startX;
  dragState.dy = e.clientY - dragState.startY;

  // Zoraki İrade: Akıl <25 veya Sinyal >75 iken sola çekmeye çalışırsan %30 ihtimalle
  // kart elinden kurtulup sağa doğru direnç gösterir — oyuncunun kontrolü dışına çıkar.
  if (!dragState.resistRolled && dragState.dx < -15 && corruptionActive()) {
    dragState.resistRolled = true;
    if (Math.random() < RESIST_CHANCE) {
      dragState.resisting = true;
      els.card.classList.add("resisting");
      vibrate(40);
    }
  }

  if (dragState.resisting) {
    updateChoiceHighlight(SWIPE_COMMIT_PX + 30); // görsel geri bildirim tamamen "sağ"a kilitlenir
    AudioEngine.updateCrackle(Math.abs(dragState.dx) + 60);
    return;
  }

  const rotate = clampNum(dragState.dx / 12, -MAX_ROTATE_DEG, MAX_ROTATE_DEG);
  els.card.style.transform = `translate(${dragState.dx}px, ${dragState.dy * 0.35}px) rotate(${rotate}deg)`;
  updateChoiceHighlight(dragState.dx);
  AudioEngine.updateCrackle(Math.abs(dragState.dx));
}

function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)); }

function onPointerUp(e) {
  if (!dragState) return;
  const { dx, resisting } = dragState;
  dragState = null;
  AudioEngine.stopCrackle();

  if (resisting) {
    els.card.classList.remove("resisting");
    els.card.classList.add("fly-out");
    els.card.style.transform = `translate(${window.innerWidth}px, -30px) rotate(40deg)`;
    AudioEngine.playClick();
    vibrate(40);
    setTimeout(() => resolveChoice("right"), 260);
    return;
  }

  if (Math.abs(dx) >= SWIPE_COMMIT_PX) {
    const side = dx < 0 ? "left" : "right";
    const flyX = dx < 0 ? -window.innerWidth : window.innerWidth;
    els.card.classList.add("fly-out");
    els.card.style.transform = `translate(${flyX}px, ${dx * 0.2}px) rotate(${dx < 0 ? -40 : 40}deg)`;
    AudioEngine.playClick();
    vibrate(40);
    setTimeout(() => resolveChoice(side), 260);
  } else {
    els.card.classList.add("snap-back");
    els.card.style.transform = "translate(0,0) rotate(0deg)";
    updateChoiceHighlight(0);
  }
}

function bindPointerEvents() {
  els.card.addEventListener("pointerdown", onPointerDown);
  els.card.addEventListener("pointermove", onPointerMove);
  els.card.addEventListener("pointerup", onPointerUp);
  els.card.addEventListener("pointercancel", onPointerUp);
}

/* ---------- Kart Çevirme (Card Flip) ---------- */
function toggleCardFlip() {
  if (els.card.classList.contains("no-flip")) return;
  els.cardFlipper.classList.toggle("flipped");
}

function bindFlipEvents() {
  els.card.addEventListener("dblclick", toggleCardFlip);
  els.flipBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCardFlip();
    });
  });
}

function bindKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (state.ended || state.hardwareFault || state.memory) return;
    const activeCard = DECK.find((c) => c.id === state.currentCardId);
    if (activeCard && activeCard.type === "memory_letter") return;
    if (state.tuning) {
      // Klavye erişilebilirliği: tuner açıkken oklar frekansı 0.1 MHz kaydırır.
      if (e.key === "ArrowLeft") {
        state.tuning.currentFreq = clampNum(state.tuning.currentFreq - 0.1, TUNE_MIN_FREQ, TUNE_MAX_FREQ);
        updateTunerUI();
      }
      if (e.key === "ArrowRight") {
        state.tuning.currentFreq = clampNum(state.tuning.currentFreq + 0.1, TUNE_MIN_FREQ, TUNE_MAX_FREQ);
        updateTunerUI();
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      AudioEngine.playClick();
      vibrate(40);
      resolveChoice("left");
    }
    if (e.key === "ArrowRight") {
      AudioEngine.playClick();
      vibrate(40);
      resolveChoice("right");
    }
  });
}

/* ---------- REC sayaç (kozmetik, gerçek zamanlı) ---------- */
function startRecTimer() {
  if (recTimerHandle) clearInterval(recTimerHandle);
  recSeconds = 0;
  recTimerHandle = setInterval(() => {
    if (state.ended) return;
    recSeconds++;
    const h = String(Math.floor(recSeconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((recSeconds % 3600) / 60)).padStart(2, "0");
    const s = String(recSeconds % 60).padStart(2, "0");
    els.recClock.textContent = `${h}:${m}:${s}`;
  }, 1000);
}

/* ---------- Tanıtım kartı: her oyunun başında, senaryoyu etkilemez ---------- */
function startIntro() {
  state.showingIntro = true;
  state.day = 0;
  renderCard(buildIntroCard(state.tapeNumber), { animateIn: false });
}

/* ---------- Yeniden başlat ---------- */
function restart() {
  if (state.tuning) stopTuning();
  if (memoryTickHandle) { clearInterval(memoryTickHandle); memoryTickHandle = null; }
  cancelRepairHold();
  stopOxygenDrain();
  state.power = 70;
  state.trust = 50;
  state.sanity = 80;
  state.signal = 15;
  state.day = 1;
  state.forcedNextId = null;
  state.usedThisPhase = new Set();
  state.pendingCallbacks = [];
  state.lastCardWasCallback = false;
  state.relationships = { selin: 50, serkan: 50, military: 50, mert: 50, defne: 50 };
  state.ended = false;
  state.hardwareFault = null;
  state.buseSecretFound = false;
  state.memoryLettersFound = [];
  state.characterFates = {};
  state.memory = null;
  state.tapeNumber = bumpTapeNumber();
  meterBlackoutActive = false;
  AudioEngine.onRestart();
  els.endingOverlay.classList.remove("show");
  els.card.classList.remove("tape-eject");
  els.hardwareFault.hidden = true;
  els.cardStage.classList.remove("fault-active");
  els.buseSecretBanner.classList.remove("show");
  els.memoryLetter.hidden = true;
  els.memoryResonance.hidden = true;
  els.cardStage.classList.remove("memory-active");
  document.documentElement.classList.remove("glitch-level-1", "glitch-level-2", "glitch-level-3", "night-shift", "sanity-crisis", "memory-mode");
  updateHUD();
  startIntro();
  startRecTimer();
}

function cacheEls() {
  els.card = qs(".card");
  els.cardStage = qs(".card-stage");
  els.cardFlipper = qs(".card-flipper");
  els.flipBtns = document.querySelectorAll(".flip-btn");
  els.impactLeft = qs(".impact-left");
  els.impactRight = qs(".impact-right");
  els.cardImage = qs("#cardImage");
  els.portraitWrap = qs(".portrait-wrap");
  els.relationshipHud = qs(".relationship-hud");
  els.speaker = qs(".who");
  els.quoteText = qs(".quote-text");
  els.leftLabel = qs(".choice.left .choice-label");
  els.rightLabel = qs(".choice.right .choice-label");
  els.choiceLeft = qs(".choice.left");
  els.choiceRight = qs(".choice.right");
  els.choices = qs(".choices");
  els.tuner = qs(".tuner");
  els.tunerFreq = qs(".tuner-freq");
  els.tunerTrack = qs(".tuner-track");
  els.tunerNeedle = qs(".tuner-needle");
  els.tunerLed = qs(".tuner-led");
  els.tunerStatusText = qs(".tuner-status-text");
  els.tunerLockFill = qs(".tuner-lock-fill");
  els.hintLeft = qs(".drag-hint.left");
  els.hintRight = qs(".drag-hint.right");
  els.stampLeft = qs(".stamp-left");
  els.stampRight = qs(".stamp-right");
  els.archiveLineIntro = qs(".intro-archive");
  els.archiveLineEnding = qs(".ending-archive");

  els.statReadout = {};
  document.querySelectorAll(".stat-readout-value").forEach((el) => {
    els.statReadout[el.dataset.stat] = el;
  });
  els.hardwareFault = qs(".hardware-fault");
  els.faultTitle = qs(".fault-title");
  els.faultDesc = qs(".fault-desc");
  els.repairBtn = qs(".repair-btn");
  els.repairFill = qs(".repair-fill");
  els.buseSecretBanner = qs(".buse-secret-banner");

  els.memoryLetter = qs(".memory-letter");
  els.memoryLetterText = qs(".memory-letter-text");
  els.memoryFocusBtn = qs(".memory-focus-btn");
  els.memoryContinueBtn = qs(".memory-continue-btn");
  els.memoryResonance = qs(".memory-resonance");
  els.memoryWaveRef = qs(".memory-wave-ref");
  els.memoryWavePlayer = qs(".memory-wave-player");
  els.memorySlider = qs(".memory-slider");
  els.memoryLed = qs(".memory-led");
  els.memoryStatusText = qs(".memory-status-text");
  els.memoryLockFill = qs(".memory-lock-fill");
  els.day = qs(".hud-day");
  els.recClock = qs(".rec-clock");
  els.tape = qs(".subtitle");
  els.meters = {};
  Object.entries(METER_SELECTORS).forEach(([key, sel]) => {
    els.meters[key] = qs(sel);
  });
  els.endingOverlay = qs(".ending-overlay");
  els.endingTitle = qs(".ending-title");
  els.endingBody = qs(".ending-body");
  els.endingStats = qs(".ending-stats");
  els.restartBtn = qs(".restart-btn");

  els.settingsBtn = qs(".settings-btn");
  els.settingsOverlay = qs(".settings-overlay");
  els.settingsClose = qs(".settings-close");
  els.fullscreenBtn = qs(".fullscreen-btn");
  els.masterSlider = qs("#masterSlider");
  els.musicSlider = qs("#musicSlider");
  els.sfxSlider = qs("#sfxSlider");
  els.masterValue = qs("#masterValue");
  els.musicValue = qs("#musicValue");
  els.sfxValue = qs("#sfxValue");

  els.titleScreen = qs(".title-screen");
  els.titleSnow = qs(".title-snow");
  els.ledText = qs(".emergency-led .led-text");
  els.btnNewBroadcast = qs(".btn-new-broadcast");
  els.btnContinueBroadcast = qs(".btn-continue-broadcast");
  els.btnSettingsMenu = qs(".btn-settings-menu");
  els.btnArchive = qs(".btn-archive");
  els.archivePopupOverlay = qs(".archive-popup-overlay");
  els.archivePopupSummary = qs(".archive-popup-summary");
  els.archivePopupList = qs(".archive-popup-list");
  els.archivePopupClose = qs(".archive-popup-close");
  els.tapePlayer = qs(".tape-player");
  els.tapePlayerTitle = qs(".tape-player-title");
  els.tapeTranscript = qs(".tape-transcript");
  els.tapePlayerClose = qs(".tape-player-close");
  els.codexOverlay = qs(".codex-overlay");
  els.codexList = qs(".codex-list");
  els.codexClose = qs(".codex-close");
  els.btnCodexTitle = qs(".btn-codex");
  els.settingsCodexBtn = qs(".settings-codex-btn");
}

/* ---------- Ana Menü (Title Screen) ---------- */
function generateSnow(count = 40) {
  if (!els.titleSnow) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const flake = document.createElement("span");
    flake.className = "snowflake";
    const size = 2 + Math.random() * 2;
    flake.style.left = Math.random() * 100 + "%";
    flake.style.width = flake.style.height = size + "px";
    flake.style.animationDuration = (6 + Math.random() * 8) + "s";
    flake.style.animationDelay = (Math.random() * -14) + "s";
    flake.style.setProperty("--drift", (Math.random() * 60 - 30) + "px");
    frag.appendChild(flake);
  }
  els.titleSnow.appendChild(frag);
}

function startEmergencyLed() {
  if (!els.ledText) return;
  let showLost = false;
  setInterval(() => {
    showLost = !showLost;
    els.ledText.textContent = showLost ? "SIGNAL LOST" : "REC";
  }, 1800);
}

/* ---------- Bant Arşivi: kaset listesi + oynatıcı (Tape Vault) ---------- */
function buildTapeVaultEntries() {
  const discoveredEndings = loadDiscoveredEndings();
  const discoveredFinales = loadDiscoveredFinales();
  const entries = Object.entries(ENDINGS).map(([key, ending]) => ({
    key,
    title: ending.title,
    transcript: ending.body,
    found: discoveredEndings.has(key),
  }));
  Object.entries(CHARACTER_FINALES).forEach(([key, finale]) => {
    entries.push({ key, title: finale.title, transcript: finale.transcript, found: discoveredFinales.has(key) });
  });
  return entries.map((entry, i) => ({ ...entry, tapeLabel: `BANT_${String(i + 1).padStart(2, "0")}` }));
}

function populateArchivePopup() {
  const discovered = loadDiscoveredEndings();
  const highScore = loadHighScoreDay();
  els.archivePopupSummary.textContent =
    `Kayıtlı En Uzun Yayın: ${highScore} Gün | Keşfedilen Sonlar: ${discovered.size}/${TOTAL_ENDINGS}`;
  els.archivePopupList.innerHTML = "";
  buildTapeVaultEntries().forEach((entry) => {
    const li = document.createElement("li");
    li.className = entry.found ? "found playable" : "";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = entry.found ? "[►]" : "[ ]";
    const label = document.createElement("span");
    label.textContent = entry.found ? `${entry.tapeLabel} — ${entry.title}` : `${entry.tapeLabel} — ???`;
    li.append(mark, label);
    if (entry.found) {
      li.addEventListener("click", () => playTape(entry));
    }
    els.archivePopupList.appendChild(li);
  });
}
function openArchivePopup() {
  populateArchivePopup();
  closeTapePlayer();
  els.archivePopupOverlay.classList.add("show");
}
function closeArchivePopup() {
  closeTapePlayer();
  els.archivePopupOverlay.classList.remove("show");
}

let tapeTypeHandle = null;
function playTape(entry) {
  AudioEngine.playClick();
  AudioEngine.playTapeInsert();
  closeTapePlayer();
  els.tapePlayer.hidden = false;
  els.tapePlayerTitle.textContent = `${entry.tapeLabel} — ${entry.title}`;
  els.tapePlayer.classList.add("playing");

  let i = 0;
  const full = entry.transcript;
  els.tapeTranscript.innerHTML = '<span class="cursor-blink">▍</span>';
  tapeTypeHandle = setInterval(() => {
    i += 2;
    const shown = full.slice(0, i);
    els.tapeTranscript.innerHTML = `${shown}<span class="cursor-blink">▍</span>`;
    if (Math.random() < 0.12) AudioEngine.playHoverStatic();
    if (i >= full.length) {
      clearInterval(tapeTypeHandle);
      tapeTypeHandle = null;
      els.tapePlayer.classList.remove("playing");
      els.tapeTranscript.textContent = full;
    }
  }, 35);
}
function closeTapePlayer() {
  if (tapeTypeHandle) { clearInterval(tapeTypeHandle); tapeTypeHandle = null; }
  els.tapePlayer.classList.remove("playing");
  els.tapePlayer.hidden = true;
}

function hideTitleScreen() {
  els.titleScreen.classList.add("closing");
  setTimeout(() => { els.titleScreen.hidden = true; }, 500);
}

function startNewBroadcast() {
  AudioEngine.playClick();
  clearGameProgress();
  hideTitleScreen();
  AudioEngine.playTapeInsert();
  startRecTimer();
  startIntro();
}

function resumeBroadcast() {
  const saved = loadGameProgress();
  if (!saved) return;
  AudioEngine.playClick();
  hideTitleScreen();
  AudioEngine.playTapeInsert();

  state.day = saved.day;
  state.power = saved.power;
  state.trust = saved.trust;
  state.sanity = saved.sanity;
  state.signal = saved.signal;
  state.tapeNumber = saved.tapeNumber;
  state.forcedNextId = saved.forcedNextId;
  state.pendingCallbacks = saved.pendingCallbacks || [];
  state.usedThisPhase = new Set(saved.usedThisPhase || []);
  // Object.assign: eski (Mert/Defne eklenmeden önceki) kayıtlarda eksik anahtarlar 50 varsayılanını alır.
  state.relationships = Object.assign(
    { selin: 50, serkan: 50, military: 50, mert: 50, defne: 50 },
    saved.relationships || {}
  );
  state.lastCardWasCallback = false;
  state.showingIntro = false;
  state.ended = false;
  state.buseSecretFound = !!saved.buseSecretFound;
  state.hardwareFault = saved.hardwareFault || null;
  state.memoryLettersFound = Array.isArray(saved.memoryLettersFound) ? saved.memoryLettersFound : [];
  state.characterFates = saved.characterFates && typeof saved.characterFates === "object" ? saved.characterFates : {};

  updateNightShift();
  AudioEngine.stopMenuMusic();
  AudioEngine.startGameplayMusic();
  updateHUD();
  const card = DECK.find((c) => c.id === saved.currentCardId) || pickCard();
  renderCard(card, { animateIn: false });
  if (state.hardwareFault) renderHardwareFault();
  startRecTimer();
}

function initTitleScreen() {
  generateSnow();
  startEmergencyLed();
  els.btnContinueBroadcast.disabled = !hasSavedGame();

  [els.btnNewBroadcast, els.btnContinueBroadcast, els.btnSettingsMenu, els.btnArchive, els.btnCodexTitle].forEach((btn) => {
    btn.addEventListener("pointerenter", () => AudioEngine.playHoverStatic());
  });

  els.btnNewBroadcast.addEventListener("click", startNewBroadcast);
  els.btnContinueBroadcast.addEventListener("click", resumeBroadcast);
  els.btnSettingsMenu.addEventListener("click", () => { AudioEngine.playClick(); openSettings(); });
  els.btnArchive.addEventListener("click", () => { AudioEngine.playClick(); openArchivePopup(); });
  els.archivePopupClose.addEventListener("click", () => { AudioEngine.playClick(); closeArchivePopup(); });
  els.archivePopupOverlay.addEventListener("click", (e) => {
    if (e.target === els.archivePopupOverlay) closeArchivePopup();
  });
  els.tapePlayerClose.addEventListener("click", () => { AudioEngine.playClick(); closeTapePlayer(); });
  els.btnCodexTitle.addEventListener("click", () => { AudioEngine.playClick(); openCharacterCodex(); });
  els.codexClose.addEventListener("click", () => { AudioEngine.playClick(); closeCharacterCodex(); });
  els.codexOverlay.addEventListener("click", (e) => {
    if (e.target === els.codexOverlay) closeCharacterCodex();
  });

  // Ana menü açıldığında ilk tıklamada menu.mp3 başlasın (tarayıcı autoplay politikası gereği).
  els.titleScreen.addEventListener("pointerdown", () => AudioEngine.ensure(), { once: true });
}

/* ---------- Ayarlar paneli (Sinyal Kontrol Ünitesi) ---------- */
function openSettings() {
  AudioEngine.ensure(); // panel ilk kullanıcı etkileşimi olabilir, sesi burada da başlat
  els.settingsOverlay.classList.add("show");
}
function closeSettings() {
  els.settingsOverlay.classList.remove("show");
}

function setupVolumeSlider(slider, valueLabel, setter) {
  const apply = (percent) => {
    slider.value = percent;
    slider.style.setProperty("--fill", percent + "%");
    valueLabel.textContent = percent + "%";
    setter(percent / 100);
  };
  slider.addEventListener("input", () => apply(Number(slider.value)));
  return apply;
}

function initSettingsPanel() {
  const volumes = AudioEngine.getVolumes();
  const applyMaster = setupVolumeSlider(els.masterSlider, els.masterValue, AudioEngine.setMasterVolume);
  const applyMusic = setupVolumeSlider(els.musicSlider, els.musicValue, AudioEngine.setMusicVolume);
  const applySfx = setupVolumeSlider(els.sfxSlider, els.sfxValue, AudioEngine.setSfxVolume);
  applyMaster(Math.round(volumes.master * 100));
  applyMusic(Math.round(volumes.music * 100));
  applySfx(Math.round(volumes.sfx * 100));

  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) closeSettings(); // sadece dış karartılmış alana tıklanınca kapat
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.settingsOverlay.classList.contains("show")) closeSettings();
  });
  els.settingsCodexBtn.addEventListener("click", () => { AudioEngine.playClick(); openCharacterCodex(); });

  function updateFullscreenLabel() {
    els.fullscreenBtn.textContent = document.fullscreenElement ? "[ TAM EKRANDAN ÇIK ]" : "[ TAM EKRAN ]";
  }
  els.fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => { /* tarayıcı izin vermedi, yoksay */ });
    }
  });
  document.addEventListener("fullscreenchange", updateFullscreenLabel);
  updateFullscreenLabel();
}

function init() {
  cacheEls();
  buildSegmentBars();
  state.tapeNumber = loadTapeNumber();
  bindPointerEvents();
  bindTunerEvents();
  bindFlipEvents();
  bindHardwareFaultEvents();
  bindPortraitEvents();
  bindMemoryEvents();
  bindKeyboard();
  els.restartBtn.addEventListener("click", restart);
  initSettingsPanel();
  initTitleScreen();
  updateHUD();
  schedulePortraitHorrorFlash();
  // Müzik filtresi/wobble/fısıltı katmanını kart geçişlerinden bağımsız, sürekli günceller.
  setInterval(() => AudioEngine.updateForState(state.sanity, state.signal), 500);
}

document.addEventListener("DOMContentLoaded", init);
