// Firebaseコンソール > プロジェクト設定 > 全般 > マイアプリ から取得した値を貼り付けてください
export const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// node generate-passcode.js で自動生成される8桁の合言葉(このファイルの値が上書きされます)
export const PASSCODE = "00000000";
