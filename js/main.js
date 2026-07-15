import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initFirebase, ensureSignedIn, firebaseSignOut } from "./firebase.js";
import {
  loadSavedConfig,
  saveConfig,
  clearConfig,
  validateConfig,
  parseFirebaseConfigSnippet,
  encodeInviteLink,
  decodeSetupParam,
} from "./project.js";
import { compressImage } from "./image.js";

const PASSCODE_KEY = "hibinote_passcode_ok";
const AUTHOR_KEY = "hibinote_author";
const MAX_DOC_SIZE = 900_000; // Firestore 1ドキュメント上限(1MB)に対する安全マージン

let db = null;
let reportsCol = null;
let passcodeDocRef = null;
let passcodeUnsubscribe = null;

let currentPasscode = null;
let passcodeLoaded = false;

let reports = [];
let unsubscribeReports = null;
let editingId = null;
let pendingImages = [];
let activeView = "list";
let previousView = "list";
let expandedDates = new Set();
let expandedInitialized = false;

const views = {
  list: document.getElementById("list-view"),
  detail: document.getElementById("detail-view"),
  editor: document.getElementById("editor-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("hidden", key !== name);
  }
  activeView = name;
}

function showTopScreen(name) {
  document.getElementById("setup-screen").classList.toggle("hidden", name !== "setup");
  document.getElementById("gate-screen").classList.toggle("hidden", name !== "gate");
  document.getElementById("app-screen").classList.toggle("hidden", name !== "app");
}

function setLoading(isLoading) {
  document.getElementById("loading-overlay").classList.toggle("hidden", !isLoading);
}

// ---------- プロジェクト設定(Firebase接続先) ----------

function boot() {
  const params = new URLSearchParams(location.search);
  const setupParam = params.get("setup");
  if (setupParam) {
    const url = new URL(location.href);
    url.searchParams.delete("setup");
    history.replaceState(null, "", url);

    const decoded = decodeSetupParam(setupParam);
    if (decoded) {
      const existing = loadSavedConfig();
      const isDifferent = existing && JSON.stringify(existing) !== JSON.stringify(decoded);
      if (
        !existing ||
        !isDifferent ||
        confirm("招待リンクのプロジェクトに切り替えますか?(現在の合言葉ログイン状態はリセットされます)")
      ) {
        if (isDifferent) closeGate();
        saveConfig(decoded);
      }
    }
  }

  const config = loadSavedConfig();
  if (config) {
    launchWithConfig(config);
  } else {
    showTopScreen("setup");
  }
}

function launchWithConfig(config) {
  db = initFirebase(config);
  reportsCol = collection(db, "reports");
  passcodeDocRef = doc(db, "settings", "passcode");
  subscribePasscode();

  if (isGateOpen()) {
    startApp();
  } else {
    showTopScreen("gate");
    document.getElementById("passcode-input").focus();
  }
}

document.getElementById("setup-save-btn").addEventListener("click", () => {
  const text = document.getElementById("setup-config-input").value.trim();
  const errorEl = document.getElementById("setup-error");
  errorEl.textContent = "";

  if (!text) {
    errorEl.textContent = "Firebaseの設定を貼り付けてください";
    return;
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    config = parseFirebaseConfigSnippet(text);
  }

  if (!validateConfig(config)) {
    errorEl.textContent = "設定を読み取れませんでした。Firebaseコンソールのコードをそのまま貼り付けてください";
    return;
  }

  saveConfig(config);
  document.getElementById("invite-link-text").value = encodeInviteLink(config);
  document.getElementById("setup-form-box").classList.add("hidden");
  document.getElementById("setup-invite-box").classList.remove("hidden");
});

document.getElementById("copy-invite-btn").addEventListener("click", () =>
  copyText("invite-link-text", "copy-invite-btn")
);

document.getElementById("setup-continue-btn").addEventListener("click", () => {
  launchWithConfig(loadSavedConfig());
});

async function copyText(sourceId, btnId) {
  const source = document.getElementById(sourceId);
  const text = "value" in source ? source.value : source.textContent;
  if (source.select) source.select();
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById(btnId);
    const original = btn.textContent;
    btn.textContent = "コピーしました";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.error(err);
  }
}

// ---------- 合言葉ゲート ----------

function isGateOpen() {
  return localStorage.getItem(PASSCODE_KEY) === "1";
}

function openGate() {
  localStorage.setItem(PASSCODE_KEY, "1");
}

function closeGate() {
  localStorage.removeItem(PASSCODE_KEY);
}

function updateGateStatus() {
  const statusEl = document.getElementById("passcode-status");
  const submitBtn = document.querySelector("#passcode-form button[type=submit]");
  if (!passcodeLoaded) {
    statusEl.textContent = "読み込み中...";
    submitBtn.disabled = true;
  } else if (!currentPasscode) {
    statusEl.textContent = "まだ合言葉が発行されていません。下の「管理者用」から発行してください。";
    submitBtn.disabled = true;
  } else {
    statusEl.textContent = "";
    submitBtn.disabled = false;
  }
}

function subscribePasscode() {
  if (passcodeUnsubscribe) passcodeUnsubscribe();
  passcodeLoaded = false;
  passcodeUnsubscribe = onSnapshot(
    passcodeDocRef,
    (snap) => {
      passcodeLoaded = true;
      currentPasscode = snap.exists() ? snap.data().code : null;
      updateGateStatus();
    },
    (err) => {
      console.error(err);
      passcodeLoaded = true;
      document.getElementById("passcode-status").textContent = "合言葉の読み込みに失敗しました";
    }
  );
}

document.getElementById("passcode-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("passcode-input");
  const value = input.value.trim();
  if (currentPasscode && value === currentPasscode) {
    openGate();
    startApp();
  } else {
    document.getElementById("passcode-error").textContent = "合言葉が違います";
    input.value = "";
    input.focus();
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  closeGate();
  firebaseSignOut();
  location.href = location.pathname;
});

document.getElementById("switch-project-btn").addEventListener("click", () => {
  if (!confirm("別のプロジェクトに切り替えますか?現在の合言葉ログイン状態もリセットされます。")) return;
  clearConfig();
  closeGate();
  location.href = location.pathname;
});

// ---------- 招待リンク(ゲート画面から再表示) ----------

document.getElementById("show-invite-btn").addEventListener("click", () => {
  const config = loadSavedConfig();
  if (!config) return;
  document.getElementById("gate-invite-link-text").value = encodeInviteLink(config);
  document.getElementById("gate-normal").classList.add("hidden");
  document.getElementById("gate-invite").classList.remove("hidden");
});

document.getElementById("close-invite-btn").addEventListener("click", () => {
  document.getElementById("gate-invite").classList.add("hidden");
  document.getElementById("gate-normal").classList.remove("hidden");
});

document.getElementById("gate-copy-invite-btn").addEventListener("click", () =>
  copyText("gate-invite-link-text", "gate-copy-invite-btn")
);

document.getElementById("header-invite-btn").addEventListener("click", async () => {
  const config = loadSavedConfig();
  if (!config) return;
  const btn = document.getElementById("header-invite-btn");
  try {
    await navigator.clipboard.writeText(encodeInviteLink(config));
    const original = btn.textContent;
    btn.textContent = "コピーしました";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.error(err);
  }
});

// ---------- 合言葉の発行(管理者用) ----------

document.getElementById("show-admin-btn").addEventListener("click", () => {
  document.getElementById("gate-normal").classList.add("hidden");
  document.getElementById("gate-admin").classList.remove("hidden");
});

document.getElementById("close-admin-btn").addEventListener("click", () => {
  document.getElementById("generated-passcode-box").classList.add("hidden");
  document.getElementById("gate-admin").classList.add("hidden");
  document.getElementById("gate-normal").classList.remove("hidden");
});

function isTooSimplePasscode(code) {
  const digits = code.split("");
  const allSame = digits.every((d) => d === digits[0]);
  const sorted = [...digits].sort().join("");
  const ascending = digits.join("") === sorted;
  const descending = digits.join("") === [...sorted].reverse().join("");
  return allSame || ascending || descending;
}

function generateRandomPasscode() {
  let code;
  do {
    const values = new Uint32Array(8);
    crypto.getRandomValues(values);
    code = Array.from(values, (n) => n % 10).join("");
  } while (isTooSimplePasscode(code));
  return code;
}

document.getElementById("generate-passcode-btn").addEventListener("click", async () => {
  const btn = document.getElementById("generate-passcode-btn");
  btn.disabled = true;
  try {
    await ensureSignedIn();
    const code = generateRandomPasscode();
    await setDoc(passcodeDocRef, { code, updatedAt: serverTimestamp() });
    document.getElementById("generated-passcode-text").textContent = code;
    document.getElementById("generated-passcode-box").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    alert("合言葉の発行に失敗しました。通信環境を確認してください");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("copy-passcode-btn").addEventListener("click", () =>
  copyText("generated-passcode-text", "copy-passcode-btn")
);

function startApp() {
  showTopScreen("app");
  setLoading(true);
  ensureSignedIn()
    .then(subscribeReports)
    .catch((err) => {
      console.error(err);
      setLoading(false);
      alert("Firebaseへの接続に失敗しました");
    });
}

// ---------- Firestore購読 ----------

function subscribeReports() {
  if (unsubscribeReports) unsubscribeReports();
  const q = query(reportsCol, orderBy("date", "desc"), orderBy("workCode", "desc"));
  let firstLoad = true;
  unsubscribeReports = onSnapshot(
    q,
    (snapshot) => {
      reports = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderList();
      setLoading(false);
      if (firstLoad) {
        firstLoad = false;
        handleDeepLink();
      }
    },
    (err) => {
      console.error(err);
      setLoading(false);
      alert("報告データの取得に失敗しました");
    }
  );
}

function handleDeepLink() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  const num = parseInt(code, 10);
  if (Number.isNaN(num)) return;
  const found = reports.find((r) => parseInt(r.workCode, 10) === num);
  if (found) showDetail(found.id);
}

// ---------- 一覧表示 ----------

function groupByDate(list) {
  const map = new Map();
  for (const r of list) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return map;
}

function formatDateHeading(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  return `${m}/${d}(${days[dt.getDay()]})`;
}

function renderList() {
  const container = document.getElementById("report-groups");
  container.innerHTML = "";
  const emptyMessage = document.getElementById("empty-message");

  if (reports.length === 0) {
    emptyMessage.classList.remove("hidden");
    return;
  }
  emptyMessage.classList.add("hidden");

  const groups = groupByDate(reports);

  if (!expandedInitialized) {
    const firstDate = groups.keys().next().value;
    if (firstDate) expandedDates.add(firstDate);
    expandedInitialized = true;
  }

  for (const [date, items] of groups) {
    const isOpen = expandedDates.has(date);

    const section = document.createElement("section");
    section.className = "date-group";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "date-heading";
    header.setAttribute("aria-expanded", String(isOpen));
    header.textContent = `${formatDateHeading(date)} (${items.length}件)`;
    header.addEventListener("click", () => {
      if (expandedDates.has(date)) expandedDates.delete(date);
      else expandedDates.add(date);
      renderList();
    });
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "card-list";
    if (!isOpen) list.classList.add("hidden");
    for (const r of items) {
      list.appendChild(buildCard(r));
    }
    section.appendChild(list);

    container.appendChild(section);
  }
}

function buildCard(r) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "report-card";
  card.addEventListener("click", () => showDetail(r.id));

  const top = document.createElement("div");
  top.className = "report-card-top";

  const code = document.createElement("span");
  code.className = "code-badge";
  code.textContent = `#${r.workCode}`;

  const title = document.createElement("span");
  title.className = "report-card-title";
  title.textContent = r.title;

  top.append(code, title);

  const author = document.createElement("div");
  author.className = "report-card-author";
  author.textContent = r.author;

  card.append(top, author);

  if (r.images && r.images.length > 0) {
    const thumb = document.createElement("img");
    thumb.className = "report-card-thumb";
    thumb.src = r.images[0];
    thumb.alt = "";
    card.appendChild(thumb);
  }

  return card;
}

// ---------- 詳細表示 ----------

function showDetail(id) {
  const r = reports.find((x) => x.id === id);
  if (!r) return;

  previousView = "list";

  document.getElementById("detail-code").textContent = `#${r.workCode}`;
  document.getElementById("detail-date").textContent = formatDateHeading(r.date);
  document.getElementById("detail-title").textContent = r.title;
  document.getElementById("detail-author").textContent = r.author;
  document.getElementById("detail-body").innerHTML = DOMPurify.sanitize(marked.parse(r.body || ""));

  const imagesEl = document.getElementById("detail-images");
  imagesEl.innerHTML = "";
  (r.images || []).forEach((src) => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.addEventListener("click", () => openImageModal(src));
    imagesEl.appendChild(img);
  });

  document.getElementById("edit-report-btn").onclick = () => openEditor(r);
  document.getElementById("delete-report-btn").onclick = () => handleDelete(r);

  const url = new URL(location.href);
  url.searchParams.set("code", r.workCode);
  history.replaceState(null, "", url);

  showView("detail");
}

async function handleDelete(r) {
  if (!confirm(`#${r.workCode} を削除しますか?`)) return;
  setLoading(true);
  try {
    await deleteDoc(doc(db, "reports", r.id));
    const url = new URL(location.href);
    url.searchParams.delete("code");
    history.replaceState(null, "", url);
    showView("list");
  } catch (err) {
    console.error(err);
    alert("削除に失敗しました");
  } finally {
    setLoading(false);
  }
}

document.querySelectorAll(".back-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.back;
    if (target === "list") {
      const url = new URL(location.href);
      url.searchParams.delete("code");
      history.replaceState(null, "", url);
      showView("list");
    } else if (target === "prev") {
      showView(previousView);
    }
  });
});

// ---------- 投稿・編集 ----------

function computeNextWorkCode(list) {
  const max = list.reduce((m, r) => Math.max(m, parseInt(r.workCode, 10) || 0), 0);
  const next = max + 1;
  const width = Math.max(4, String(max || 0).length, String(next).length);
  return String(next).padStart(width, "0");
}

function formatDateInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function openEditor(existing) {
  previousView = activeView === "editor" ? previousView : activeView;
  editingId = existing ? existing.id : null;

  document.getElementById("editor-heading").textContent = existing
    ? `編集 #${existing.workCode}`
    : "新規投稿";
  document.getElementById("editor-author").value = existing
    ? existing.author
    : localStorage.getItem(AUTHOR_KEY) || "";
  document.getElementById("editor-title").value = existing ? existing.title : "";
  document.getElementById("editor-body").value = existing ? existing.body : "";
  document.getElementById("editor-images-input").value = "";
  document.getElementById("editor-error").textContent = "";

  pendingImages = existing ? [...(existing.images || [])] : [];
  renderImageThumbs();
  updatePreview();

  showView("editor");
}

document.getElementById("new-report-btn").addEventListener("click", () => openEditor(null));
document.getElementById("editor-cancel-btn").addEventListener("click", () => showView(previousView));

const bodyInput = document.getElementById("editor-body");
bodyInput.addEventListener("input", updatePreview);

function updatePreview() {
  document.getElementById("editor-preview").innerHTML = DOMPurify.sanitize(
    marked.parse(bodyInput.value || "")
  );
}

document.getElementById("editor-images-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  for (const file of files) {
    try {
      const dataUrl = await compressImage(file);
      pendingImages.push(dataUrl);
    } catch (err) {
      console.error(err);
    }
  }
  renderImageThumbs();
});

function renderImageThumbs() {
  const list = document.getElementById("editor-image-list");
  list.innerHTML = "";
  pendingImages.forEach((src, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap";

    const img = document.createElement("img");
    img.src = src;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "thumb-remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      pendingImages.splice(idx, 1);
      renderImageThumbs();
    });

    wrap.append(img, removeBtn);
    list.appendChild(wrap);
  });
}

document.getElementById("editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const author = document.getElementById("editor-author").value.trim();
  const title = document.getElementById("editor-title").value.trim();
  const body = document.getElementById("editor-body").value.trim();
  const errorEl = document.getElementById("editor-error");
  errorEl.textContent = "";

  if (!author || !title || !body) {
    errorEl.textContent = "投稿者名・タイトル・本文は必須です";
    return;
  }

  const approxSize = JSON.stringify({ title, body, images: pendingImages }).length;
  if (approxSize > MAX_DOC_SIZE) {
    errorEl.textContent = "画像サイズが大きすぎます。画像の枚数を減らしてください";
    return;
  }

  localStorage.setItem(AUTHOR_KEY, author);
  setLoading(true);
  try {
    if (editingId) {
      await updateDoc(doc(db, "reports", editingId), {
        title,
        body,
        author,
        images: pendingImages,
        updatedAt: serverTimestamp(),
      });
      showDetail(editingId);
    } else {
      const workCode = computeNextWorkCode(reports);
      const docRef = await addDoc(reportsCol, {
        workCode,
        date: formatDateInput(new Date()),
        title,
        body,
        author,
        images: pendingImages,
        createdAt: serverTimestamp(),
      });
      showDetail(docRef.id);
    }
  } catch (err) {
    console.error(err);
    errorEl.textContent = "保存に失敗しました。通信環境を確認してください";
  } finally {
    setLoading(false);
  }
});

// ---------- 検索 ----------

document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = document.getElementById("search-input").value.trim();
  if (!raw) return;
  const num = parseInt(raw, 10);
  if (Number.isNaN(num)) {
    alert("数字を入力してください");
    return;
  }
  const found = reports.find((r) => parseInt(r.workCode, 10) === num);
  if (found) {
    showDetail(found.id);
  } else {
    alert(`作業コード ${raw} は見つかりませんでした`);
  }
});

// ---------- 画像モーダル ----------

function openImageModal(src) {
  document.getElementById("image-modal-img").src = src;
  document.getElementById("image-modal").classList.remove("hidden");
}

function closeImageModal() {
  document.getElementById("image-modal").classList.add("hidden");
  document.getElementById("image-modal-img").src = "";
}

document.getElementById("image-modal-close").addEventListener("click", closeImageModal);
document.getElementById("image-modal").addEventListener("click", (e) => {
  if (e.target.id === "image-modal") closeImageModal();
});

// ---------- 初期化 ----------

boot();
