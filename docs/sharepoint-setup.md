# データ保存先を SharePoint (Microsoft 365) にする手順

このアプリは、イベント・メンバー・種類・設定を **SharePoint リスト** に、添付資料を **ドキュメントライブラリ** に保存できます。画面やパスコードの仕組みはそのままで、データだけが社内テナントに置かれます。

## 1. 情報システム部門への依頼内容（そのまま転送できます）

> **件名: バイオガス事業本部 イベント共有アプリ用の SharePoint 連携設定のお願い**
>
> 事業本部で使用しているイベント共有アプリのデータ保存先を、社内の SharePoint に変更したく、以下の設定をお願いします。
>
> 1. **SharePoint サイト**: 事業本部用のサイトを 1 つ用意（既存サイトでも可）。URL を教えてください。例: `https://<テナント名>.sharepoint.com/sites/biogas`
> 2. **Microsoft Entra ID のアプリ登録**を 1 件作成
>    - 名前: `Biogas Event Schedule`
>    - サポートされるアカウント: この組織のみ（シングルテナント）
>    - リダイレクト URI: 不要
>    - **証明書とシークレット**: クライアントシークレットを 1 つ発行（有効期限は運用に合わせて。期限切れ前に更新が必要）
>    - **API のアクセス許可**: Microsoft Graph → **アプリケーションの許可** → `Sites.Selected` を追加し、**管理者の同意**を付与
> 3. **サイトへの権限付与**: 上記アプリに対して、1 のサイトだけに **manage** 権限を付与（他のサイトにはアクセスできません）。
>    PnP PowerShell の例:
>    ```powershell
>    Connect-PnPOnline -Url https://<テナント名>.sharepoint.com/sites/biogas -Interactive
>    Grant-PnPAzureADAppSitePermission -AppId "<アプリ (クライアント) ID>" -DisplayName "Biogas Event Schedule" -Permissions Manage
>    ```
>    Graph Explorer の場合: `POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions` に `{"roles":["manage"],"grantedToIdentities":[{"application":{"id":"<クライアント ID>","displayName":"Biogas Event Schedule"}}]}`
> 4. 完了後、次の 3 つを安全な方法で共有してください: **テナント ID**、**アプリ (クライアント) ID**、**クライアントシークレットの値**

補足: `manage` はリストの初回作成に必要です。リスト作成後は `write` に下げても動作します。

## 2. Netlify に環境変数を設定

**Site configuration → Environment variables** に以下を追加し、**Deploys → Trigger deploy** で再デプロイします。

| 変数 | 値 |
| --- | --- |
| `STORAGE` | `sharepoint` |
| `MS_TENANT_ID` | 情シスから受け取ったテナント ID |
| `MS_CLIENT_ID` | アプリ (クライアント) ID |
| `MS_CLIENT_SECRET` | クライアントシークレットの値 |
| `SP_SITE_URL` | `https://<テナント名>.sharepoint.com/sites/<サイト名>` |
| `SP_LIST_PREFIX` | 任意。リスト名の接頭辞（既定 `Biogas` → `BiogasEvents` など） |
| `SP_LIBRARY` | 任意。資料ライブラリ名（既定 `EventMaterials`） |

初回アクセス時に、次のリストとライブラリがサイトに自動作成されます。

| SharePoint 上の名前 | 内容 |
| --- | --- |
| `BiogasEvents` | イベント（タイトル、開始/終了、種類、主担当、メンバー、状態、極秘 など） |
| `BiogasMembers` | メンバー |
| `BiogasEventTypes` | イベントの種類 |
| `BiogasMaterials` | 資料の一覧（リンクとファイルの情報） |
| `BiogasSettings` | 区分名などの設定 |
| `EventMaterials` | 添付ファイル本体（イベント ID / 資料 ID ごとのフォルダー） |

設定画面の「データ保存先」に `SharePoint` と表示され、「接続確認」でリストが見えれば完了です。

## 3. 既存データの移行（Netlify Blobs → SharePoint）

`STORAGE=sharepoint` に切り替える **前** に、手元の PC（Node.js 20 以上）で次を実行すると、いまのデータをそのまま SharePoint にコピーします。何度実行しても同じ結果になります。

```bash
git clone <このリポジトリ> && cd event-schedule && npm install
NETLIFY_SITE_ID=<Site ID> NETLIFY_AUTH_TOKEN=<個人アクセストークン> \
MS_TENANT_ID=... MS_CLIENT_ID=... MS_CLIENT_SECRET=... SP_SITE_URL=https://<テナント名>.sharepoint.com/sites/<サイト名> \
node scripts/migrate-blobs-to-sharepoint.mjs
```

- Site ID: Netlify の **Site configuration → Site details**
- 個人アクセストークン: Netlify の **User settings → Applications → Personal access tokens**

移行後に `STORAGE=sharepoint` を設定して再デプロイし、動作を確認してから Netlify 側のデータを削除します（Netlify CLI: `netlify blobs:delete` など。必要なら手順をご案内します）。

## 4. セキュリティ上のポイント

- アプリは `Sites.Selected` で指定した **1 サイトだけ** にアクセスでき、他の SharePoint サイトや個人の OneDrive には触れません。
- クライアントシークレットは Netlify の環境変数にのみ保存し、リポジトリには含めません。期限切れ前の更新を忘れないようにしてください。
- 極秘イベントは SharePoint 上では `Confidential = Yes` の行になります。SharePoint 側で直接リストを開ける人はサイトの権限に従います。極秘の行を SharePoint 上でも隠したい場合は、サイトの閲覧権限をアプリ管理者に限定してください。
- 次の段階として、パスコードを **Microsoft アカウントでのログイン (Entra ID)** に置き換えられます。希望があれば対応します。
