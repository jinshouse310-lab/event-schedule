# バイオガス事業本部 イベントスケジュール共有アプリ

日本側・インド側のメンバーで、本部の主要イベント（経営会議・バイオガス委員会・講演会・来客対応 など）を共有するための Web アプリです。

**Biogas Division shared event schedule** — a small web app for Japan- and India-side members to share the division's key events (management meetings, biogas committee, lectures, visitor receptions, ...), who owns each one, and the related materials. English notes are at the bottom of this page.

## できること

| 機能 | 内容 |
| --- | --- |
| イベント登録 | タイトル（日本語 / 英語）、種類、日時、場所、主担当、関係メンバー、状態（予定 / 確定 / 完了 / 中止）、メモ |
| 日本・インド両方の時刻表示 | 各イベントに JST と IST の時刻を並べて表示。入力はどちらのタイムゾーンでも可 |
| 一覧・カレンダー | 今後の予定 / 今月 / 3か月 / 過去 の一覧、月間カレンダー。種類・担当側・主担当・状態・キーワードで絞り込み |
| 資料保存 | イベントごとにファイルをアップロード（ドラッグ＆ドロップ対応）、または SharePoint / Google Drive などのリンクを登録 |
| メンバー管理 | 日本側 / インド側で分けて登録。役職・メールも保持。退任者は「無効化」で履歴を残したまま非表示 |
| イベント種類の管理 | 「経営会議」「バイオガス委員会」「講演会」「来客対応」「出張」「展示会」「その他」が初期登録。色付きで追加・編集可 |
| 日本語 / English 切替 | 画面右上で切替。インド側メンバーは英語表示で利用できます |
| カレンダー購読 | `/calendar.ics` を Outlook / Google カレンダーに「URL から追加」すると各自のカレンダーに自動同期 |
| 共有パスコード | 環境変数 `APP_PASSCODE` を設定すると簡易ログインが有効になります |

## 起動方法

Node.js 22.13 以上が必要です（データベースは Node 内蔵の SQLite を使うため、追加インストールは不要）。

```bash
npm install
cp .env.example .env   # 必要に応じて編集
npm start
# → http://localhost:3000
```

`.env` は自動では読み込まれないため、環境変数として渡してください。例:

```bash
APP_PASSCODE=biogas2026 SESSION_SECRET=長いランダム文字列 npm start
```

### Docker で起動する場合

```bash
APP_PASSCODE=biogas2026 SESSION_SECRET=長いランダム文字列 docker compose up -d --build
```

データ（SQLite ファイルとアップロード資料）は `./data` に保存されます。バックアップはこのフォルダをコピーするだけです。

### 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_DIR` | `./data` | DB とアップロードファイルの保存先 |
| `APP_PASSCODE` | (空) | 設定するとメンバー共通のパスコードでログインが必要になる |
| `SESSION_SECRET` | `change-me` | ログイン Cookie の署名用。必ず変更してください |
| `MAX_UPLOAD_MB` | `50` | 1 ファイルあたりの最大サイズ (MB) |

## 社内共有のヒント

- 社内サーバーやクラウド VM（1 台）に置き、日本・インド双方からアクセスできる URL を共有する構成を想定しています。
- 資料は「ファイルをこのアプリに保存」でも「SharePoint などのリンクを貼る」でもどちらでも運用できます。
- 全員に共通パスコードを配布する簡易認証です。個人別アカウントや SSO が必要になった場合はリバースプロキシ（Azure AD / Cloudflare Access など）の前段認証を組み合わせてください。

## 開発

```bash
npm run dev    # ファイル変更で自動再起動
npm test       # API テスト (node:test)
```

### 構成

```
server.js              エントリポイント (Express)
src/db.js              SQLite スキーマ・初期データ
src/auth.js            共有パスコード認証
src/routes/events.js   イベント CRUD・検索
src/routes/members.js  メンバー
src/routes/types.js    イベント種類
src/routes/materials.js 資料 (アップロード / リンク / ダウンロード)
src/routes/ics.js      iCalendar フィード
public/                フロントエンド (依存なしの HTML / CSS / JS)
test/                  API テスト
```

### API (抜粋)

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/events?from&to&type&owner&side&status&q` | イベント一覧（関係メンバー・資料を含む） |
| POST / PUT / DELETE | `/api/events[/:id]` | イベント作成 / 更新 / 削除 |
| POST | `/api/events/:id/materials/upload` | ファイル添付 (multipart, field `file`) |
| POST | `/api/events/:id/materials/link` | リンク添付 (`{url, name}`) |
| GET | `/api/materials/:id/download` | ファイルダウンロード |
| GET / POST / PUT / DELETE | `/api/members`, `/api/types` | メンバー・種類の管理 |
| GET | `/calendar.ics?lang=ja|en` | iCalendar フィード |

日時は API 上ではすべて UTC (ISO 8601) で扱い、画面側で JST / IST に変換して表示します。終日イベントは日付のみ（`YYYY-MM-DDT00:00:00Z`）で保存します。

---

## English notes

- **Run:** `npm install && npm start` (Node 22.13+), then open `http://localhost:3000`. Or `docker compose up -d --build`.
- **Login:** set `APP_PASSCODE` to require a shared passcode; leave it empty for open access on a trusted network.
- **Language / timezone:** use the 日本語 / EN and JST / IST toggles in the top bar. Every event shows both JST and IST times.
- **Materials:** upload files per event or attach links (SharePoint, Google Drive, ...). Files live under `data/uploads`.
- **Calendar sync:** subscribe to `https://<host>/calendar.ics?lang=en` from Outlook or Google Calendar.
