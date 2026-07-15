const CONFIG_KEY = "hibinote_firebase_config";
const REQUIRED_FIELDS = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];

export function loadSavedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

export function validateConfig(config) {
  return !!config && REQUIRED_FIELDS.every((key) => typeof config[key] === "string" && config[key].length > 0);
}

// FirebaseコンソールからコピーしたJS/JSONスニペットをそのまま貼れるように緩くパースする
export function parseFirebaseConfigSnippet(text) {
  const config = {};
  for (const field of REQUIRED_FIELDS) {
    const match = text.match(new RegExp(field + '\\s*:\\s*["\']([^"\']+)["\']'));
    if (match) config[field] = match[1];
  }
  return config;
}

export function encodeInviteLink(config) {
  const json = JSON.stringify(config);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("setup", base64);
  return url.toString();
}

export function decodeSetupParam(param) {
  try {
    const json = decodeURIComponent(escape(atob(param)));
    const config = JSON.parse(json);
    return validateConfig(config) ? config : null;
  } catch {
    return null;
  }
}
