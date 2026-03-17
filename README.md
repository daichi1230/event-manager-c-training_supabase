# Event Manager C + Supabase

C向けの本格動的版です。

## できること

- メールアドレス + パスワードのサインアップ / ログイン
- ロール別UI（一般ユーザー / 管理者）
- イベント作成 / 編集 / 削除（管理者）
- イベント参加 / 取消（一般ユーザー）
- 定員超過防止
- 重複参加防止
- 管理ダッシュボード
- 監査ログ表示と CSV エクスポート
- Supabase による永続化
- RLS によるアクセス制御

## 技術構成

- Vite + React
- Supabase Auth
- Supabase Postgres
- Row Level Security
- RPC (`register_event`, `cancel_registration`)
- GitHub Actions 用 CI 雛形
- Playwright 雛形

## 起動方法

### 1. 依存関係を入れる

```bash
npm install
```

### 2. 環境変数を作る

`.env.example` をコピーして `.env.local` を作ります。

```bash
cp .env.example .env.local
```

中身を自分の Supabase プロジェクト値で置き換えてください。

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

### 3. Supabase の SQL を流す

Supabase Dashboard → SQL Editor で `supabase/schema.sql` を実行してください。

### 4. 開発起動

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開きます。

### 5. 本番ビルド確認

```bash
npm run build
npm run preview
```

ブラウザで `http://localhost:4173` を開きます。

## 最初の管理者を作る方法

1. まずアプリから通常のユーザーとしてサインアップします。
2. Supabase Dashboard → SQL Editor で次を実行します。

```sql
update public.profiles
set role = 'admin'
where id = (
  select id
  from auth.users
  where email = 'your-admin@example.com'
);
```

これで次回読み込み時から管理者 UI が見えます。

## 主要テーブル

- `profiles`: 表示名とロール
- `events`: イベント本体
- `registrations`: 参加登録
- `audit_logs`: 操作履歴

## 業務ルール

### 定員超過防止
`register_event()` 関数の中で現在参加数を数え、定員以上なら例外を返します。

### 重複参加防止
`registrations(event_id, user_id)` にユニーク制約を置いています。
さらに `register_event()` 関数でも事前チェックしています。

### 監査ログ
イベントの insert / update / delete と、参加登録 / 取消は trigger で `audit_logs` に残します。

## 注意点

- このサンプルは **ブラウザから Supabase に直接接続** する構成です。
- そのため、**必ず RLS を有効にしたまま** 運用してください。
- `service_role` キーは絶対にフロントへ置かないでください。
- クライアントには `publishable key` または legacy の `anon key` を使ってください。

## デプロイ先の候補

- Vercel
- Netlify
- GitHub Pages

どれも静的フロントは配信できます。データは Supabase 側に保存されます。

## テスト

Playwright 雛形を同梱しています。

```bash
npx playwright install chromium
npm run test:e2e
```

環境変数未設定のままでは本格的な E2E は動きません。

## CI

GitHub Actions の build 用雛形を `.github/workflows/ci.yml` に入れています。
