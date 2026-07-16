# 作業報告サイト - 実装スペック

## 概要
チーム向けの汎用的な作業日報共有サイト。学園祭に限らず、他のプロジェクト・団体でもそのまま使い回せるように作る。合言葉を知っている人なら誰でも閲覧・投稿できる、軽量なWebアプリ。過去の日報も一覧からいつでも遡って見られる。

**マルチテナント設計**: リポジトリをforkしなくても、同じデプロイ済みサイト(同じURL)を無関係な複数のチームが同時に使い回せる。Firebaseプロジェクト自体はリポジトリ管理者が1つだけ用意し、コードに埋め込む。チームごとの区別・データ分離はFirestore上の「ルームID」(ランダムな文字列)で行う。**利用者は誰もFirebaseに触れる必要がない** — 招待リンクを開くか、その場で新しいチームを作るだけで使い始められる(詳細は「チーム(ルーム)管理」章)。

## 技術スタック
- フロントエンド: 素のHTML / CSS / JavaScript (フレームワーク不要、単一〜数ファイル構成)
- バックエンド: Firebase (Firestore + Anonymous Auth)。プロジェクトはリポジトリ管理者が1つ用意し、コードに埋め込む(利用者側の設定作業は不要)
- ホスティング: GitHub Pages
- Markdown描画: marked.js (CDN) + DOMPurify (CDN) ※XSS対策として必須、これを外さない
- 画像: Firestoreにcanvas圧縮したBase64文字列として保存 (Firebase Storageは使わない)

## チーム(ルーム)管理(マルチテナント化)
- Firebaseプロジェクトはコードに埋め込む(`js/firebase-config.js`)。全チーム共通の1つのプロジェクトを、Firestore上の名前空間(`rooms/{roomId}/...`)で分離して共有する
- 初回アクセス時、`localStorage` にルームIDが保存されておらずURLにも `?room=` が無ければ「ようこそ画面」を表示する
  - 主役は「招待リンクを貼り付けて参加する」(既存チームに参加したい人がほとんど想定なので、大きい入力欄+ボタンで前面に出す)
  - 下に控えめに「招待リンクを持っていない場合: 新しくチームを作る」リンクを置く。押すと `crypto.getRandomValues` でランダムなルームID(英数字10文字程度)をその場で生成し、「あなた専用の新しいチームができました」画面で招待リンク(`index.html?room=<ルームID>`)を提示する。「はじめる」で合言葉画面へ進む
- **招待リンク**: `?room=<ルームID>` を開くと、そのルームIDが即座に`localStorage`へ保存され(貼り付け作業なし)、URLパラメータは履歴から取り除かれる
  - 招待リンクは合言葉ゲート画面・アプリのヘッダーからもいつでも再表示・コピーできるようにする
- 合言葉ゲート画面に「別のチームに切り替える」リンクを置き、押すと確認の上で保存済みのルームIDと合言葉ログイン状態をクリアして再読み込みする(再読み込み時に新しいルームIDが自動発行される)
- 招待リンクを開いた際、既に別のルームIDが保存されていて内容が異なる場合は上書き前に確認を取る(誤って別チームのデータに繋がってしまうのを防ぐ)
- 各チームが完全に独立したFirebaseプロジェクトを持ちたい場合(データを自社の課金・クォータで管理したい等)は、リポジトリをforkして `js/firebase-config.js` を書き換える(コード改変が必要な上級者向けの逃げ道として明記するのみでよい)

## 認証まわり
- **アカウント登録なし。** 初回アクセス時に「合言葉入力画面」を出す。
- 合言葉が正しければ:
  1. `localStorage` に合言葉一致フラグを保存(以降スキップ)
  2. 裏側でFirebase Anonymous Authを自動実行(ユーザー操作不要、見た目に一切出さない)
- **合言葉は6桁のランダムな数字**(例: `048238` のような、連番でなくランダム生成された文字列)。チーム(ルーム)ごとに独立している
  - 新規チーム作成時にその場で初回の合言葉を自動発行する(作成した人はその場でログイン済みになる)。以降は合言葉入力画面の「招待リンク・合言葉を確認する」パネル(ログイン後にヘッダーの「招待リンク」からも開ける)から確認・「合言葉を発行し直す」ができる
  - `crypto.getRandomValues` で6桁のランダム数字を生成し、Firestore(`rooms/{roomId}/settings/passcode` ドキュメント)に書き込む
  - Node.jsスクリプトの実行やコードの書き換え・再デプロイは不要。発行・確認ともにサイト上で完結する
  - 001のような連番・推測しやすい値にはしない
- **合言葉はFirestoreセキュリティルール上で実際に検証する。** クライアント側で値を読んで比較するのではなく、「セッション証明ドキュメント」の作成を試み、ルールが `settings/passcode` の値と突き合わせて成否を判定する(詳細は「認証の仕組み(セッション証明)」章)。ルームIDだけを知っていても合言葉を知らなければデータへは到達できない
- 簡易ロックアウト: 同一端末(匿名認証のUID単位)で5回連続して合言葉を間違えると1時間ログインを試行できなくする。バックエンドを持たない設計上、IPアドレス等での識別はできずログアウトして新しいUIDを取得すれば回避できてしまうが、通常のUI操作からの連打・素朴な総当たりを止める簡易的な抑止として割り切る

### 認証の仕組み(セッション証明)
- `rooms/{roomId}/sessions/{uid}` ドキュメントが「そのユーザーは正しい合言葉を知っている」ことのサーバー側証明。作成時にルールが `request.resource.data.passcode == (settings/passcodeの値)` を検証するため、間違った値では作成自体が失敗する
- ログイン処理は「合言葉を読んで比較する」のではなく「このセッションドキュメントの作成を試みて、成功したらログイン成功・失敗(permission-denied)したらログイン失敗」という流れで行う
- `settings/passcode` の読み取りや `reports/*` の読み書きは、このセッション証明を持っている(=ログイン済みである)ことを条件にする
- 合言葉を発行し直しても、既にセッション証明を持っている(=ログイン済みの)端末は追い出されない。新しいログイン試行にのみ新しい合言葉が必要になる

### ログアウト機能
- ヘッダーに「ログアウト」ボタンを常設
- 押すと `localStorage` の合言葉一致フラグを削除し、Firebase Anonymous Authもサインアウトする(次回は新しいUIDで再ログインする形になる) → 合言葉入力画面に戻る
- 用途: 端末を共有してる場合や、別の合言葉(別チーム・別プロジェクト)に切り替えたい場合

```js
// セキュリティルール例(Firestore)
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId}/sessions/{uid} {
      allow read, delete: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null && request.auth.uid == uid
        && (
          !exists(/databases/$(database)/documents/rooms/$(roomId)/loginAttempts/$(uid))
          || get(/databases/$(database)/documents/rooms/$(roomId)/loginAttempts/$(uid)).data.lockedUntil == null
          || get(/databases/$(database)/documents/rooms/$(roomId)/loginAttempts/$(uid)).data.lockedUntil < request.time
        )
        && request.resource.data.passcode == get(/databases/$(database)/documents/rooms/$(roomId)/settings/passcode).data.code;
    }
    match /rooms/{roomId}/loginAttempts/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /rooms/{roomId}/settings/passcode {
      allow read: if request.auth != null
        && exists(/databases/$(database)/documents/rooms/$(roomId)/sessions/$(request.auth.uid));
      allow create: if request.auth != null
        && !exists(/databases/$(database)/documents/rooms/$(roomId)/settings/passcode);
      allow update: if request.auth != null
        && exists(/databases/$(database)/documents/rooms/$(roomId)/sessions/$(request.auth.uid));
    }
    match /rooms/{roomId}/reports/{reportId} {
      allow read, write: if request.auth != null
        && exists(/databases/$(database)/documents/rooms/$(roomId)/sessions/$(request.auth.uid));
    }
  }
}
```

## データモデル

すべて `rooms/{roomId}/...` の下に配置し、チームごとに完全に分離する。`roomId` はクライアント側で生成するランダム文字列で、URLの `?room=` パラメータや招待リンクとして共有される。

### `rooms/{roomId}/settings/passcode` ドキュメント(ルームごとに1件)

```
rooms/{roomId}/settings/passcode
  code: string        現在有効な6桁の合言葉
  updatedAt: timestamp
```

### `rooms/{roomId}/sessions/{uid}` ドキュメント(ログイン成功時に作成)

```
rooms/{roomId}/sessions/{uid}
  passcode: string    ログイン時に入力された合言葉(ルールでの検証用)
  createdAt: timestamp
```

### `rooms/{roomId}/loginAttempts/{uid}` ドキュメント(ログイン失敗回数の記録)

```
rooms/{roomId}/loginAttempts/{uid}
  count: number
  lockedUntil: timestamp | null
  updatedAt: timestamp
```

### `rooms/{roomId}/reports` コレクション

```
rooms/{roomId}/reports/{reportId}
  workCode: string    例 "0001" (通し連番、数字のみ、ルーム内で共通)
  date: string        例 "2026-07-15" (YYYY-MM-DD)
  title: string
  body: string         Markdown形式の本文
  images: array<string>  Base64エンコード画像(複数可)
  author: string
  createdAt: timestamp
  updatedAt: timestamp (編集した場合)
```

### 作業コードのルール
- 形式: **数字のみの連番**(例: `0001`, `0002`, `0003`...)。全報告共通で通し番号にする(プロジェクトやカテゴリで分けない、シンプル最優先)
- 投稿時にFirestoreクエリで既存の最大値を取得し、+1して自動採番(ユーザーは何も入力しない)
- 4桁ゼロ埋め表示(1000件超えたら5桁に自然に伸びてOK)
- URLパラメータで直リンク可能に: `index.html?code=0001` → 該当報告を自動オープン
- 検索窓には数字を入れるだけで該当報告にジャンプできるようにする

## 画面構成

### 0a. ようこそ画面(そのブラウザで初回のみ、ルームIDが無い場合。招待リンクで開いた場合は自動スキップ)
- 主役は招待リンクの貼り付け欄+「参加する」ボタン
- 下に控えめに「新しくチームを作る」リンク

### 0b. 新規チーム作成画面(「新しくチームを作る」を押した場合のみ表示)
- 作成と同時に初回の合言葉も自動発行し、作成した人はその場でログイン済みにする
- 招待リンクと発行された合言葉の表示(この画面を離れると合言葉は再確認できない旨を明記)
- 「はじめる」でメイン画面に進む(合言葉入力は不要、既にログイン済みのため)

### 1. 合言葉入力画面(ルーム決定後、未ログインの場合に表示)
- シンプルな1入力+ボタン
- 間違い時はエラー表示、5回間違えると1時間ロック。正解でメイン画面へ遷移
- 「招待リンク・合言葉を確認する」「別のチームに切り替える」の2つのリンクを併設。前者は招待リンクの確認のみ(合言葉はログイン前の画面には出さない)

### 2. 一覧画面(トップ)
- 日付ごとにグルーピングして新しい順に表示(例: 見出し `7/15(火)` の下にその日の報告カードが並ぶ)
- 各カードにはタイトル・作業コード・投稿者を表示、画像はサムネイル1枚だけ先出し
- 日付見出しをタップすると開閉(アコーディオン)
- ヘッダー常設: 作業コード検索窓(入力してEnterで該当報告にジャンプ)

### 3. 詳細画面
- タイトル、作業コード、投稿者、日付
- 本文をMarkdown→HTML変換して表示(marked.js→DOMPurifyでサニタイズ)
- 画像はタップで拡大表示(モーダル)
- 編集・削除ボタン(投稿者本人かどうかのチェックは今回は省略してOK、チーム内前提のため)

### 4. 新規投稿・編集画面
- 入力項目: タイトル、本文(Markdown)、画像(複数選択可)。作業コードは自動採番なので入力欄なし
- 本文欄の下か横にリアルタイムプレビュー
- 画像選択時にJS(canvas)で自動圧縮:
  - 長辺800px程度にリサイズ
  - JPEG品質0.7前後で再エンコード
  - 目安1枚あたり100〜200KB、Firestore1ドキュメント上限1MBに収まるよう合計サイズもチェック
- 保存ボタンで作業コードを自動採番してFirestoreに書き込み

## Markdown記法サポート範囲
最低限これだけ対応できればOK(marked.jsのデフォルトでほぼ賄える):
- `#` `##` 見出し
- `**強調**`
- `-` 箇条書き
- 改行・段落

## モバイル対応
- スマホでの閲覧・投稿がメイン想定。タップ領域は大きめに、フォームは縦積みレイアウトで。
- 画像アップロードは `<input type="file" accept="image/*" capture>` でカメラ起動も考慮

## 実装順序の推奨
1. Firebaseの初期化(`js/firebase-config.js` に埋め込み済みのプロジェクトでinitializeApp)
2. ようこそ画面(招待リンク参加/新規チーム作成の分岐)・ルームIDのlocalStorage保存・招待リンク発行
3. 合言葉ゲート + Anonymous Auth実装(Firestore上の合言葉発行UIを含む)
4. Firestore CRUD(投稿・一覧取得、すべて `rooms/{roomId}/...` 配下)
5. 一覧画面(日付グルーピング)
6. 詳細画面(Markdown描画)
7. 投稿・編集画面(画像圧縮込み)
8. 作業コード検索・直リンク機能
9. GitHub Pagesデプロイ設定

## Firebaseプロジェクトについて
- **リポジトリ管理者が1つだけFirebaseプロジェクトを作成し、コード(`js/firebase-config.js`)に埋め込む。** 利用者(チームの管理者・メンバー)は誰もFirebaseに触れる必要がない
- 無料のSparkプランで要件は全て賄える(Firestore + Anonymous Authは無料枠内、Storageは使わない設計のため課金の心配なし)。多数のチームが同じプロジェクトを共有する前提のため、利用規模が大きくなる場合は無料枠の上限に注意する
- 準備手順(管理者が最初に1回だけ): Firebaseコンソールで新規プロジェクト作成 → Firestore Database有効化(ルールは本ファイル記載のものを適用) → Authenticationで「匿名」を有効化 → マイアプリでウェブアプリを追加して設定を取得し `js/firebase-config.js` に貼り付け、の4ステップ
