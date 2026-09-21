# バイオガス事業本部 イベントスケジュール共有アプリ

日本側・インド側のメンバーで、本部の主要イベント（経営会議・バイオガス委員会・講演会・来客対応 など）と、その主担当・関連資料を共有するための Web アプリです。**Netlify にそのまま公開できます**（静的サイト + Netlify Functions + Netlify Blobs。追加のデータベース契約は不要です）。

**Biogas Division shared event schedule** — Japan- and India-side members share the division's key events, who owns each one, and the related materials. Deploys to Netlify as-is. English notes are at the bottom.

## できること

| 機能 | 内容 |
| --- | --- |
| イベント登録 | タイトル（日本語 / 英語）、種類、日時、場所、主担当、関係メンバー、状態（予定 / 確定 / 完了 / 中止）、メモ |
| 日本・インド両方の時刻表示 | 各イベントに JST と IST の時刻を並べて表示。入力はどちらのタイムゾーンでも可 |
| 一覧・カレンダー | 今後の予定 / 今月 / 3か月 / 過去 の一覧と月間カレンダー。種類・担当側・主担当・状態・キーワードで絞り込み |
| 資料保存 | イベントごとにファイルをアップロード（ドラッグ＆ドロップ対応）、または SharePoint / Google Drive などのリンクを登録 |
| メンバー管理 | 日本側 / インド側で分けて登録。役職・メールも保持。退任者は「無効化」で履歴を残したまま非表示 |
| イベント種類の管理 | 経営会議・バイオガス委員会・講演会・来客対応・出張・展示会・その他 が初期登録。色付きで追加・編集可 |
| 日本語 / English 切替 | 画面右上で切替。インド側メンバーは英語表示で利用できます |
| カレンダー購読 | `/calendar.ics` を Outlook / Google カレンダーに「URL から追加」すると各自のカレンダーに自動同期 |
| 共有パスコード | 環境変数 `APP_PASSCODE` を設定するとログインが必要になります |

## Netlify で公開する手順

1. この GitHub リポジトリを Netlify に接続します。  
   Netlify にログイン → **Add new site → Import an existing project → GitHub** → このリポジトリを選択。
2. ビルド設定は `netlify.toml` に入っているので、そのまま **Deploy** してください。  
   （Build command: 空欄、Publish directory: `public`、Functions: `netlify/functions`）
3. デプロイ後、**Site configuration → Environment variables** で以下を追加し、再デプロイ（Deploys → Trigger deploy）します。

   | 変数 | 値の例 | 説明 |
   | --- | --- | --- |
   | `APP_PASSCODE` | `biogas2026` | メンバー共通のログインパスコード。未設定だと誰でも閲覧・編集できます |
   | `SESSION_SECRET` | 長いランダム文字列 | ログイン Cookie の署名用。必ず設定してください |
   | `MAX_UPLOAD_MB` | `4` | 1 ファイルの上限 (MB)。Netlify Functions の制限により 4 以下を推奨 |

4. `https://<サイト名>.netlify.app` をメンバーに共有すれば完了です。独自ドメインは **Domain management** から設定できます。

### 公開後のポイント

- **データの保存先**: イベント・メンバー・資料はすべて Netlify Blobs（サイトに紐づくストレージ）に保存されます。再デプロイしても消えません。
- **資料サイズの上限**: Netlify Functions のリクエスト上限（約 6 MB）のため、1 ファイル 4 MB 程度までです。大きい資料は SharePoint / Google Drive のリンクとして登録してください。
- **アクセス制限**: 共有パスコードは簡易的な仕組みです。より厳密にする場合は Netlify の Site protection（有料）や Netlify Identity を前段に置いてください。
- **カレンダー購読 URL**: パスコードを設定している場合、`/calendar.ics` もログイン Cookie が必要になります。ブラウザでログイン後にダウンロードして取り込むか、パスコードなし運用で購読 URL を使ってください。
- **バックアップ**: Netlify CLI で `netlify blobs:list events` などで確認・取得できます（`netlify link` でサイトに接続後）。

## ローカルで動かす / 自前サーバーで動かす

Node.js 20 以上が必要です。Netlify のストレージと同じ API を持つファイルベースのサーバーを内蔵しているので、Netlify なしでも動きます。

```bash
npm install
APP_PASSCODE=biogas2026 SESSION_SECRET=長いランダム文字列 npm start
# → http://localhost:3000   (データは ./data に保存)
```

Netlify CLI があれば、本番と同じ Functions 経由で動作確認もできます。

```bash
npm install -g netlify-cli
netlify dev
```

Docker で自前サーバーに置く場合:

```bash
APP_PASSCODE=biogas2026 SESSION_SECRET=長いランダム文字列 docker compose up -d --build
```

## 開発

```bash
npm run dev    # ファイル変更で自動再起動
npm test       # API テスト (node:test)
```

### 構成

```
netlify.toml               Netlify の設定 (publish, functions, リダイレクト)
netlify/functions/api.mjs  Netlify Function (/api/*, /calendar.ics)
src/app.mjs                ルーティング・認証・イベント/メンバー/資料の処理 (fetch 互換ハンドラ)
src/store.mjs              Netlify Blobs 上のドキュメントストア
src/ics.mjs                iCalendar 生成
server.mjs                 ローカル / 自前サーバー用 (同じハンドラをローカル Blobs サーバーで実行)
public/                    フロントエンド (依存なしの HTML / CSS / JS)
test/                      API テスト
```

### API (抜粋)

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/events?from&to&type&owner&side&status&q` | イベント一覧（`materials_count` 付き） |
| GET | `/api/events/:id` | イベント詳細（関係メンバー・資料を含む） |
| POST / PUT / DELETE | `/api/events[/:id]` | イベント作成 / 更新 / 削除 |
| POST | `/api/events/:id/materials/upload` | ファイル添付 (multipart, field `file`) |
| POST | `/api/events/:id/materials/link` | リンク添付 (`{url, name}`) |
| GET | `/api/materials/:eventId/:id/download` | ファイルダウンロード |
| DELETE | `/api/materials/:eventId/:id` | 資料削除 |
| GET / POST / PUT / DELETE | `/api/members`, `/api/types` | メンバー・種類の管理 |
| GET | `/calendar.ics?lang=ja|en` | iCalendar フィード |

日時は API 上ではすべて UTC (ISO 8601) で扱い、画面側で JST / IST に変換して表示します。終日イベントは日付のみ（`YYYY-MM-DDT00:00:00Z`）で保存します。

---

## English notes

- **Deploy on Netlify:** import this repo (Add new site → Import an existing project), deploy, then set `APP_PASSCODE`, `SESSION_SECRET` and `MAX_UPLOAD_MB=4` under Site configuration → Environment variables and trigger a redeploy. Data lives in Netlify Blobs; no external database is needed.
- **Upload limit:** about 4 MB per file on Netlify (function request limit). Use links for larger materials.
- **Run locally:** `npm install && npm start` (Node 20+), then open `http://localhost:3000`. Or `netlify dev` for the exact production routing.
- **Language / timezone:** 日本語 / EN and JST / IST toggles in the top bar. Every event shows both JST and IST times.
- **Calendar sync:** subscribe to `https://<site>/calendar.ics?lang=en` from Outlook or Google Calendar (requires no passcode, or import the file after logging in).
