# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## リポジトリの現状

git 管理下の public リポジトリ（`sano-suguru/ambit`）。設計仕様（README・DESIGN.md）に加えて、最初の垂直スライス（§4.2 の効果伝播規則が実コードで動き、§5.1 の構造化診断が NDJSON で出るところまで）を実装済み。`rfcs/`・`conformance/` は未作成。

**実際のツールチェーン**（DESIGN.md §3.1 から実装時に変更した点を含む）:

- パッケージ管理は pnpm（`packageManager` 固定）。**単一パッケージ構成**（`pnpm workspaces` は使わない。`@ambit/core` 等への分割は npm publish が視野に入ってから）
- 型解析は旧 TypeScript Compiler API（`typescript@5.9.3` に固定）。ネイティブバックエンドとの比較（M0.5）は未着手 — 詳細は下記「M1 を M0.5 より先行させている理由」
- **開発時はビルドしない**。Node 24 の型ストリッピングで `.ts` を直接実行する（`node src/cli/main.ts check <dir> --format json`）。`tsc` は型検査（`--noEmit`）専用。`tsconfig.json` の `erasableSyntaxOnly: true` により enum・namespace・parameter properties は使えない
- 相対 import は **`.ts` 拡張子**で書く（`.js` ではない。Node のネイティブ型ストリッピングが要求する）
- リンタ・フォーマッタは **Biome**（`node:test` ではなく **Vitest** をテストランナーに採用 — DESIGN.md §3.1 から変更。理由は git 履歴のコミットメッセージ参照）
- テストは `pnpm test`、型検査は `pnpm exec tsc --noEmit`、lint は `pnpm exec biome ci .`

**ディレクトリ構成の制約**: `src/core/` と `src/stubs/` は `typescript` を import しない（`test/architecture.test.ts` が担保）。`typescript` を import してよいのは `src/checker/backend/legacy-ts.ts` のみ — DESIGN.md §3.4 の接続層で、この実装は M0.5 未検証のため使い捨て前提（採択済みではない）。

**言語ポリシーの例外**: 文章は日本語が原則だが、**`README.md`・診断メッセージ本文・`docs/diagnostics/` は英語**。想定読者（AI エージェントでコードを書く Node.js バックエンド開発者）の大半が英語圏であるため。`docs/DESIGN.md`・RFC・コミットメッセージ・Issue は日本語のまま。

**診断 `id` の安定性**（§5.2 の「削除・再利用しない」）は最初の npm publish（正式公開）から適用する。それまで `docs/diagnostics/` は書きながら追記する生きた台帳で、`AMB-E001` 等の番号は変わりうる。

## Ambit とは

TypeScript の上に乗る契約層。JSDoc タグ（`@effects` / `@capabilities` / `@budget` / `@entrypoint` / `@boundary`）で副作用・権限・予算を宣言し、AI が書いたコードの契約違反を `ambit check` が止める。新文法・独自ランタイム・独自レジストリは作らない。

## 設計の要点（DESIGN.md の複数節にまたがるもの）

**設計原則 P1→P5 の優先順**（§2）: 既存言語に乗る → AI の行動範囲を制約 → 未宣言を禁止しない → 保証できない範囲を隠さない → いつでも撤退できる。原則が衝突したらこの順で優先する。

**5 層の責任分離**（§3.4）: コンパイラ接続 / Ambit の解析表現 / 契約解析 / 提示・制御 / ランタイム強制。コンパイラ固有のオブジェクトや内部 ID は接続層の外（診断・永続形式・公開シンボル ID）へ出さない。ランタイムは解析エンジンに依存しない。

**パッケージの責任**（§6.1）: `@ambit/core` はコンパイラ API に依存しない。`@ambit/checker` が接続層の情報で契約解析を行い、CLI とエディタで共用する。`@ambit/runtime` は本番依存で、コンパイラや CLI を持ち込まない。**現在の実装は npm パッケージに分割せず、単一パッケージ内の `src/core/` `src/checker/` `src/cli/` `src/stubs/` ディレクトリで同じ責任分離を表現している**（`@ambit/runtime` は未着手。`src/stubs/` は Node.js 標準モジュールの最小限のエフェクト定義のみ）。

**契約モデル**（§4）: 静的検査は関数単位、ランタイム強制はエントリポイント単位。`unknown` は中核概念で、禁止ではなく `--coverage` で可視化する。effects の伝播規則と標準エフェクト一覧は §4.2、capabilities の縮小則は §4.4、budget は「宣言・計測・遮断」であり静的保証しない（§4.5）。

**構造化診断**（§5）: 第一の消費者は AI エージェント。NDJSON、安定した診断 `id`、`fixes[].edits` は適用可能な具体的パッチのみ。契約を守る修正と緩める修正を `consistentWithContract` で区別する。

## 仕様編集時の約束

- 本仕様は Draft。Go 製ネイティブ TypeScript バックエンドは **候補** であり、§3.5 の検証ゲート通過まで採択済みと書かない。
- 「検証済み」と「未検証」を分ける記述を保つ。未実行のバックエンドに性能値を割り当てない。付録 A は M0.5 の予備検証であり完了ではない。
- RFC が必要な変更（§9）: 診断コードの意味、標準エフェクト、伝播規則、既定バックエンド、TypeScript 対応範囲の破壊的変更。ただし RFC 手続き自体は正式公開後の運用として位置づけている（上記「診断 `id` の安定性」参照）。公開前の仕様修正はこのファイルと DESIGN.md を直接更新する。
- 現在位置は M1（契約解析コアの実装）を M0.5（バックエンド比較）より先行させている。理由: §3.4 の接続層による隔離設計により契約解析はバックエンド非依存に進められ、個人開発では二トラック並走が最も効率を落とすため。マイルストーンの定義は §11 のまま変更していないが、実際の着手順はこれと異なる。
- 文章は日本語（README・診断メッセージ・`docs/diagnostics/` を除く。上記「言語ポリシーの例外」参照）。README と DESIGN.md の用語（effects / capabilities / budget / boundary / unknown は英語表記）に合わせる。
