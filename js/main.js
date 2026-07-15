import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ensureSignedIn, firebaseSignOut } from "./firebase.js";
import { PASSCODE } from "./config.js";
import { compressImage } from "./image.js";

const PASSCODE_KEY = "hibinote_passcode_ok";
const AUTHOR_KEY = "hibinote_author";
const MAX_DOC_SIZE = 900_000; // Firestore 1ドキュメント上限(1MB)に対する安全マージン

const reportsCol = collection(db, "reports");

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

function setLoading(isLoading) {
  document.getElementById("loading-overlay").classList.toggle("hidden", !isLoading);
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

document.getElementById("passcode-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("passcode-input");
  const value = input.value.trim();
  if (value === PASSCODE) {
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

function startApp() {
  document.getElementById("gate-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");
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

if (isGateOpen()) {
  startApp();
} else {
  document.getElementById("passcode-input").focus();
}
