import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ensureSignedIn, firebaseSignOut } from "./firebase.js";
import {
  generateRoomId,
  isValidRoomId,
  loadRoomId,
  saveRoomId,
  clearRoomId,
  buildInviteLink,
} from "./project.js";
import { compressImage } from "./image.js";

// main.jsの読み込み・評価がここまで到達した = 通信/構文エラーで詰んではいない
if (window.__hibinoteBootTimer) clearTimeout(window.__hibinoteBootTimer);

const PASSCODE_KEY = "hibinote_passcode_ok";
const AUTHOR_KEY = "hibinote_author";
const MAX_DOC_SIZE = 900_000; // Firestore 1ドキュメント上限(1MB)に対する安全マージン

let roomId = null;
let reportsCol = null;
let passcodeDocRef = null;
let passcodeUnsubscribe = null;

let currentPasscode = null;

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
  teaminfo: document.getElementById("team-info-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("hidden", key !== name);
  }
  activeView = name;
}

function showTopScreen(name) {
  document.getElementById("boot-loading").classList.add("hidden");
  document.getElementById("welcome-screen").classList.toggle("hidden", name !== "welcome");
  document.getElementById("new-room-screen").classList.toggle("hidden", name !== "newroom");
  document.getElementById("gate-screen").classList.toggle("hidden", name !== "gate");
  document.getElementById("app-screen").classList.toggle("hidden", name !== "app");
}

function setLoading(isLoading) {
  document.getElementById("loading-overlay").classList.toggle("hidden", !isLoading);
}

// ---------- チーム(ルーム)の決定 ----------

function boot() {
  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  if (roomParam && isValidRoomId(roomParam)) {
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);

    const existing = loadRoomId();
    const isDifferent = existing && existing !== roomParam;
    if (
      !existing ||
      !isDifferent ||
      confirm("招待リンクのチームに切り替えますか?(現在の合言葉ログイン状態はリセットされます)")
    ) {
      if (isDifferent) closeGate();
      saveRoomId(roomParam);
    }
  }

  const savedRoomId = loadRoomId();
  if (savedRoomId) {
    enterRoom(savedRoomId, { isNew: false });
  } else {
    showTopScreen("welcome");
  }
}

function enterRoom(id, { isNew }) {
  roomId = id;
  reportsCol = collection(db, "rooms", roomId, "reports");
  passcodeDocRef = doc(db, "rooms", roomId, "settings", "passcode");

  if (isNew) {
    showTopScreen("newroom");
  } else if (isGateOpen()) {
    startApp();
  } else {
    showTopScreen("gate");
    document.getElementById("passcode-input").focus();
  }
}

function parseRoomIdInput(raw) {
  let candidate = raw;
  try {
    candidate = new URL(raw).searchParams.get("room") || "";
  } catch {
    // URLでなければ、そのままルームIDとして扱う
  }
  return candidate;
}

document.getElementById("welcome-join-btn").addEventListener("click", () => {
  const raw = document.getElementById("welcome-join-input").value.trim();
  const errorEl = document.getElementById("welcome-join-error");
  errorEl.textContent = "";

  if (!raw) {
    errorEl.textContent = "招待リンクを貼り付けてください";
    return;
  }

  const candidate = parseRoomIdInput(raw);
  if (!isValidRoomId(candidate)) {
    errorEl.textContent = "招待リンクを読み取れませんでした。URLをそのまま貼り付けてください";
    return;
  }

  saveRoomId(candidate);
  enterRoom(candidate, { isNew: false });
});

// 新規チームは作成の時点でその場で初回合言葉を発行し、作成者は自動的にログイン済みにする。
// (ルール変更後は未ログイン状態で「合言葉が発行済みか」を判定できないため、
//  ゲート画面に着地する前に必ず合言葉とセッションが揃っている状態にする)
document.getElementById("welcome-create-btn").addEventListener("click", async () => {
  const btn = document.getElementById("welcome-create-btn");
  btn.disabled = true;
  try {
    const id = generateRoomId();
    const code = generateRandomPasscode();
    const user = await withTimeout(ensureSignedIn(), 10000);
    await setDoc(doc(db, "rooms", id, "settings", "passcode"), { code, updatedAt: serverTimestamp() });
    await setDoc(doc(db, "rooms", id, "sessions", user.uid), { passcode: code, createdAt: serverTimestamp() });

    saveRoomId(id);
    openGate();
    enterRoom(id, { isNew: true });
    document.getElementById("new-room-invite-link").value = buildInviteLink(roomId);
    document.getElementById("new-room-passcode-text").textContent = code;
  } catch (err) {
    console.error(err);
    alert("チームの作成に失敗しました。通信環境を確認してください");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("new-room-continue-btn").addEventListener("click", () => {
  if (isGateOpen()) {
    startApp();
  } else {
    showTopScreen("gate");
    document.getElementById("passcode-input").focus();
  }
});

document.getElementById("copy-new-room-invite-btn").addEventListener("click", () =>
  copyText("new-room-invite-link", "copy-new-room-invite-btn")
);

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

// 合言葉の検証はローカル比較ではなく、Firestoreルールが実際に検証する
// 「セッション証明ドキュメントの作成」を試みることで行う。成功=合言葉が正しい。
async function attemptLogin(code) {
  const errorEl = document.getElementById("passcode-error");
  const statusEl = document.getElementById("passcode-status");
  errorEl.textContent = "";
  statusEl.textContent = "";

  let user;
  try {
    user = await withTimeout(ensureSignedIn(), 10000);
  } catch (err) {
    console.error(err);
    errorEl.textContent = "通信に失敗しました。もう一度お試しください";
    return;
  }

  const attemptsRef = doc(db, "rooms", roomId, "loginAttempts", user.uid);
  let attemptsSnap = null;
  try {
    attemptsSnap = await getDoc(attemptsRef);
  } catch (err) {
    console.error(err);
  }
  if (attemptsSnap && attemptsSnap.exists()) {
    const lockedUntil = attemptsSnap.data().lockedUntil;
    if (lockedUntil && lockedUntil.toMillis() > Date.now()) {
      const mins = Math.ceil((lockedUntil.toMillis() - Date.now()) / 60000);
      errorEl.textContent = `試行回数が多すぎます。${mins}分後に再試行してください`;
      return;
    }
  }

  try {
    await setDoc(doc(db, "rooms", roomId, "sessions", user.uid), {
      passcode: code,
      createdAt: serverTimestamp(),
    });
    await deleteDoc(attemptsRef).catch(() => {});
    openGate();
    startApp();
  } catch (err) {
    console.error(err);
    await recordFailedAttempt(attemptsRef, attemptsSnap);
    errorEl.textContent = "合言葉が違います";
  }
}

async function recordFailedAttempt(attemptsRef, prevSnap) {
  const prevCount = prevSnap && prevSnap.exists() ? prevSnap.data().count || 0 : 0;
  const newCount = prevCount + 1;
  const data = { count: newCount, updatedAt: serverTimestamp(), lockedUntil: null };
  if (newCount >= 5) {
    data.count = 0;
    data.lockedUntil = new Date(Date.now() + 60 * 60 * 1000);
  }
  try {
    await setDoc(attemptsRef, data);
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("passcode-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("passcode-input");
  const code = input.value.trim();
  attemptLogin(code);
});

document.getElementById("logout-btn").addEventListener("click", () => {
  closeGate();
  firebaseSignOut();
  location.href = location.pathname;
});

document.getElementById("switch-project-btn").addEventListener("click", () => {
  if (
    !confirm(
      "別の新しいチームを始めますか?現在の合言葉ログイン状態もリセットされます。参加したいチームがある場合は、このボタンではなくそのチームの招待リンクを開いてください。"
    )
  )
    return;
  clearRoomId();
  closeGate();
  location.href = location.pathname;
});

// ---------- 招待リンク(ゲート画面から確認、合言葉ゲート通過前なので合言葉自体は出さない) ----------

document.getElementById("show-invite-btn").addEventListener("click", () => {
  document.getElementById("gate-invite-link-text").value = buildInviteLink(roomId);
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

// ---------- 招待リンク・合言葉(ログイン後のヘッダーから確認/再発行) ----------

function updateAppPasscodeDisplay() {
  const el = document.getElementById("app-current-passcode-text");
  if (el) el.textContent = currentPasscode || "(未発行)";
}

document.getElementById("header-invite-btn").addEventListener("click", () => {
  document.getElementById("app-invite-link-text").value = buildInviteLink(roomId);
  updateAppPasscodeDisplay();
  previousView = activeView === "teaminfo" ? previousView : activeView;
  showView("teaminfo");
});

document.getElementById("app-copy-invite-btn").addEventListener("click", () =>
  copyText("app-invite-link-text", "app-copy-invite-btn")
);

document.getElementById("app-copy-passcode-btn").addEventListener("click", () =>
  copyText("app-current-passcode-text", "app-copy-passcode-btn")
);

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
    const values = new Uint32Array(6);
    crypto.getRandomValues(values);
    code = Array.from(values, (n) => n % 10).join("");
  } while (isTooSimplePasscode(code));
  return code;
}

document.getElementById("app-reissue-passcode-btn").addEventListener("click", async () => {
  const btn = document.getElementById("app-reissue-passcode-btn");
  btn.disabled = true;
  try {
    await withTimeout(ensureSignedIn(), 10000);
    const code = generateRandomPasscode();
    await setDoc(passcodeDocRef, { code, updatedAt: serverTimestamp() });
    // currentPasscodeとその表示はonSnapshotのコールバックで自動更新される
  } catch (err) {
    console.error(err);
    alert("合言葉の発行に失敗しました。通信環境を確認してください");
  } finally {
    btn.disabled = false;
  }
});

// ensureSignedIn()はFirebase Auth内部(IndexedDB等)の問題で
// 成功も失敗も返さず固まることがあるため、タイムアウトで打ち切れるようにする
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function startApp() {
  showTopScreen("app");
  setLoading(true);
  withTimeout(ensureSignedIn(), 10000)
    .then(() => {
      subscribePasscode();
      subscribeReports();
    })
    .catch((err) => {
      console.error(err);
      setLoading(false);
      alert("読み込みに失敗しました。通信環境をご確認のうえ再読み込みしてください。");
    });
}

// ログイン後(セッション証明あり)にだけ購読できる。チーム情報パネルでの表示用。
function subscribePasscode() {
  if (passcodeUnsubscribe) passcodeUnsubscribe();
  passcodeUnsubscribe = onSnapshot(
    passcodeDocRef,
    (snap) => {
      currentPasscode = snap.exists() ? snap.data().code : null;
      updateAppPasscodeDisplay();
    },
    (err) => {
      console.error(err);
    }
  );
}

// ---------- Firestore購読 ----------

function sortReports(list) {
  list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (a.workCode || "") < (b.workCode || "") ? 1 : -1;
  });
}

function subscribeReports() {
  if (unsubscribeReports) unsubscribeReports();
  // orderByを2つ以上重ねると複合インデックスの手動作成が必要になり、
  // Firebase設定を一切触らせない設計と相性が悪いのでソートはクライアント側で行う
  let firstLoad = true;
  // 通信環境によってはonSnapshotが成功も失敗も返さず固まることがあるための保険
  const timeoutId = setTimeout(() => {
    if (!firstLoad) return;
    setLoading(false);
    alert("読み込みに時間がかかっています。通信環境をご確認のうえ再読み込みしてください。");
  }, 10000);
  unsubscribeReports = onSnapshot(
    reportsCol,
    (snapshot) => {
      clearTimeout(timeoutId);
      reports = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      sortReports(reports);
      renderList();
      setLoading(false);
      if (firstLoad) {
        firstLoad = false;
        handleDeepLink();
      }
    },
    (err) => {
      clearTimeout(timeoutId);
      console.error(err);
      setLoading(false);
      if (firstLoad && err.code === "permission-denied") {
        // ルール変更等でこの端末のセッション証明が無効になっているケース。
        // 詰ませずに合言葉の再入力に戻す。
        closeGate();
        showTopScreen("gate");
        document.getElementById("passcode-status").textContent = "もう一度合言葉を入力してください。";
        document.getElementById("passcode-input").focus();
      } else {
        alert("報告データの取得に失敗しました");
      }
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

function goToList() {
  const url = new URL(location.href);
  url.searchParams.delete("code");
  history.replaceState(null, "", url);
  showView("list");
}

async function handleDelete(r) {
  if (!confirm(`#${r.workCode} を削除しますか?`)) return;
  setLoading(true);
  try {
    await deleteDoc(doc(db, "rooms", roomId, "reports", r.id));
    goToList();
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
      goToList();
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

async function addImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const dataUrl = await compressImage(file);
      pendingImages.push(dataUrl);
    } catch (err) {
      console.error(err);
    }
  }
  renderImageThumbs();
}

document.getElementById("editor-images-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  await addImageFiles(files);
});

document.getElementById("editor-view").addEventListener("paste", async (e) => {
  const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
  const files = items
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return; // 通常のテキスト貼り付けはそのまま
  e.preventDefault();
  await addImageFiles(files);
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
      await updateDoc(doc(db, "rooms", roomId, "reports", editingId), {
        title,
        body,
        author,
        images: pendingImages,
        updatedAt: serverTimestamp(),
      });
    } else {
      const workCode = computeNextWorkCode(reports);
      await addDoc(reportsCol, {
        workCode,
        date: formatDateInput(new Date()),
        title,
        body,
        author,
        images: pendingImages,
        createdAt: serverTimestamp(),
      });
    }
    goToList();
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
