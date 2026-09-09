# Goal: 現実的な Node バックエンドで「エージェントの事故」を止められることを実証する

## 背景（現状の事実）

- `ambit check` が今止められる事故は「`pure` 宣言の関数内で `fetch` / `node:fs` を呼ぶ」だけ。
- バンドルされた stub は `network / fs_read / fs_write / process / env` しか生まない。`pure` 関数が
  DB ドライバや LLM SDK を呼んでも `unknown` になり、違反にならない（README「Known limitations」）。
- §4.4 の二重強制のうち静的側（付与された `http:get:api.example.com` の外にあるリテラル URL を
  check 時に拒否する）は未実装（docs/status.md M2）。
- barrel file 経由の再エクスポートは解決できず `unknown` になる（README）。
- 実測の `unknown` 率は Ambit 自身に対する 63.2% のみ。§10 の目標（採用チームで 30% 以下）を
  測る「採用チーム相当のコード」がリポジトリに存在しない。
- つまり現時点で Ambit は「コーディングエージェントが書く典型的な SaaS API コード」に対して、
  違反を止めた実例を一つも持っていない。これを埋めるのがこのゴール。

## ゴール

`test/fixtures/realistic-api/` に、コーディングエージェントが実際に書く形の小さな
Node.js バックエンドを作り、そこに仕込んだ「エージェントが起こしがちな事故」を
`ambit check` がすべて止めることを自動テストで示す。

fixture の要件:

- Hono / Express 風の HTTP ハンドラ（`@entrypoint` + `@capabilities` + `@budget` 付き）を数本
- DB クライアント呼び出し（`pg` と `@prisma/client` の両方、最小の型定義を fixture 内に置き、
  実インストールは不要にする）
- LLM SDK 呼び出し（`openai` または `@anthropic-ai/sdk` のどちらか一つ、同様に最小型定義）
- `src/lib/index.ts` のような barrel file を通した import
- 純粋なドメインロジック（税計算・バリデーション等）が数関数

仕込む事故と、期待する結果:

| # | 事故 | 今の挙動 | 期待 |
|---|---|---|---|
| 1 | `@effects pure` の関数に `fetch()` が追加される | AMB-E001 | AMB-E001（回帰確認） |
| 2 | `@effects pure` の関数に `prisma.user.findMany()` / `pool.query()` が追加される | `unknown` | `db_read` または `db_write` の違反として error |
| 3 | `@effects pure` の関数に `openai.chat.completions.create()` が追加される | `unknown` | `llm` の違反として error |
| 4 | `@capabilities http:get:api.example.com` のエントリポイント内に `fetch("https://elsewhere.example/…")` が書かれる | 何も出ない | 新規診断 id で error（§4.4 二重強制の静的側） |
| 5 | barrel file 経由で import した `network` 関数を `pure` 関数が呼ぶ | `unknown` | AMB-E001（barrel の解決） |
| 6 | `@entrypoint` JSDoc の `@capabilities` と、同一ファイルで同じハンドラを包む `withAmbit({ capabilities: [...] })` のリテラル配列が食い違う（片方にだけ `db:write:users` が足される） | 何も出ない | 新規診断 id で error。動的に組まれた配列・別ファイルのハンドラは `unknown` 相当とし、診断文でそう言う |

## 受け入れ基準

すべて機械的に確認できること。満たせない項目は「満たせなかった」と数字付きで書く。

1. `test/e2e.realistic.test.ts` が存在し、
   - baseline の fixture に対して `check` が error 0 で exit 0
   - 事故 1〜6 の各バリアントに対して、期待した診断 id が期待した位置に出て exit 1
   - `ambit init` を baseline の未宣言関数に適用 → 提案パッチを機械適用 → 再 `check` が clean
2. fixture に対する `check --coverage` の `unknown-rate` が **30% 以下**。
   残る `unknown` は `unresolved-by-reason` と `top-unresolved-names` で全件説明がつく状態にし、
   その出力を `docs/status.md` に「採用チーム相当コードでの実測」として追記する
   （Ambit 自身の 63.2% とは別の行。混ぜない）。
3. 新しい stub は **メソッド単位で正確に**入れる。
   - `pg` の `query(sql)` のように読み書きが静的に決まらない操作をどのエフェクトにするか
     （リテラル SQL の先頭キーワードで振り分ける／非リテラルは `db_read, db_write` の両方とする等）は
     **設計判断**なので、コードで黙って決めず `docs/DESIGN.md` §4.2 または stub の節に一文で記録する。
   - 「フックがある＝任意 SQL のテーブル権限を判定できる」とは書かない（§4.4 の但し書きを守る）。
4. 事故 4・事故 6 の新規診断は `docs/diagnostics/README.md` に登録し、`fixes[]` を持たせられないなら
   空のまま出す（§5.3 に従い、安全に生成できないパッチは捏造しない）。
   `http:<method>:<host>` の照合対象はリテラル文字列 URL とテンプレートリテラルの静的部分まで。
   動的 URL はランタイム側の責務として静的側では `unknown` 相当に留め、診断文でそう言う。
   事故 6 の検査は **ソース上の一致のみ**。§12「契約とハンドラの対応付け」（コメントが消えるビルド、
   バンドル後）は解かないので、その旨を `docs/DESIGN.md` に一文追記する。
5. `README.md` の「What is actually enforced」表と「Known limitations」、`docs/limitations.md`、
   `docs/status.md` M2 の Outstanding を、実装後に **真である状態**に書き直す。
   「Nothing bundled produces `db_read`, `db_write`, or `llm`」「literal URL in source: not implemented」
   が偽になるなら、その文を消す。逆に新たにできないと分かったことは Known limitations に足す。
6. `pnpm test` / `pnpm exec tsc --noEmit` / `pnpm exec biome ci .` / `test/architecture.test.ts`
   がすべて通る。`src/core/` と `src/stubs/` は `typescript` を import しない。

## 制約

- `AGENTS.md` に従う。特に:「仕様がスコープ境界、diff の大きさではない」「半分閉じた状態は完成ではない」
  「保証面積を仮定で増やさない」「根本原因が分かった欠陥は直す、記録して済ませない」。
- `docs/DESIGN.md` §12 に挙がっている設計未決事項（`pure` の検証範囲、`Array.push` / `Map.set` 等の
  ローカル変異の扱い）は **このゴールで勝手に決めない**。fixture の unknown 率が 30% を切れない原因が
  それなら、切れなかった数字と「なぜ」を status.md に書いて止める。allowlist を膨らませて数字を作らない。
- `ambit.config.ts`、framework adapter、runtime hook の追加、`ambit agent` は **このゴールの対象外**
  （それぞれ後続ゴール。`docs/goals/` を参照）。
- バックエンド（`legacy-ts.ts`）は使い捨ての接続層のまま。性能数値を新たに主張しない。
- `erasableSyntaxOnly`、相対 import の `.ts` 拡張子、Node 24 / TS 5.9.3 固定は維持。
- コミットは既存履歴と同じ粒度・形式（`feat: … / fix: … / docs: …` を日本語で）。
  fixture 追加、stub 追加、barrel 解決、リテラル URL 検査、withAmbit 一致検査、docs 更新は別コミットにする。

## 完了報告に含めるもの

- 事故 1〜6 それぞれについて、`check --format json` の実出力 1 行
- fixture の `check --coverage` 出力（before: 実装前の数字も一度測って残す / after）
- 受け入れ基準のうち満たせなかったものと、その理由（一行）
- このゴールの作業中に見つかったが対象外と判断した欠陥は、issue または §12 の一行として記録
