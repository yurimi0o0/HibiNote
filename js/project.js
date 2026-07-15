const ROOM_KEY = "hibinote_room_id";
const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// URLで共有しやすい、推測困難なランダムID(チーム=Firestore上の名前空間)
export function generateRoomId(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

export function isValidRoomId(id) {
  return typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);
}

export function loadRoomId() {
  return localStorage.getItem(ROOM_KEY);
}

export function saveRoomId(roomId) {
  localStorage.setItem(ROOM_KEY, roomId);
}

export function clearRoomId() {
  localStorage.removeItem(ROOM_KEY);
}

export function buildInviteLink(roomId) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", roomId);
  return url.toString();
}
