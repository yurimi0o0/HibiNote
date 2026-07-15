import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
// LINEなどアプリ内ブラウザではFirestoreの既定のストリーミング接続が確立できず
// onSnapshotが成功も失敗もせず無限に待ち続けることがあるため、自動でlong-pollingに切り替える
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        unsubscribe();
        if (user) {
          resolve(user);
        } else {
          signInAnonymously(auth)
            .then((cred) => resolve(cred.user))
            .catch(reject);
        }
      },
      reject
    );
  });
}

export function firebaseSignOut() {
  return signOut(auth).catch(() => {});
}
