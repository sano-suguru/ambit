# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## リポジトリの現状

設計・技術検証段階のドキュメントのみ。`README.md` と `docs/DESIGN.md` の 2 ファイルで、`package.json`・ソースコード・テスト・git 管理は存在しない。ビルド・lint・テストのコマンドはまだない。存在しないコマンドを書かない。

仕様が参照するディレクトリ（`rfcs/`、`docs/diagnostics/`、`conformance/`、`stubs/`、`packages/*`）も未作成。

**予定しているツールチェーン**（DESIGN.md §3.1。実装時にこの節を更新する）: pnpm workspaces、固定版 tsc によるビルド、`node:test`、適合テストスイート、GitHub Actions、npm 配布。Ambit 本体は TypeScript `strict: true`、基準ランタイムは Node.js 24 LTS。

## Ambit とは

TypeScript の上に乗る契約層。JSDoc タグ（`@effects` / `@capabilities` / `@budget` / `@entrypoint` / `@boundary`）で副作用・権限・予算を宣言し、AI が書いたコードの契約違反を `ambit check` が止める。新文法・独自ランタイム・独自レジストリは作らない。

## 設計の要点（DESIGN.md の複数節にまたがるもの）

**設計原則 P1→P5 の優先順**（§2）: 既存言語に乗る → AI の行動範囲を制約 → 未宣言を禁止しない → 保証できない範囲を隠さない → いつでも撤退できる。原則が衝突したらこの順で優先する。

**5 層の責任分離**（§3.4）: コンパイラ接続 / Ambit の解析表現 / 契約解析 / 提示・制御 / ランタイム強制。コンパイラ固有のオブジェクトや内部 ID は接続層の外（診断・永続形式・公開シンボル ID）へ出さない。ランタイムは解析エンジンに依存しない。

**パッケージの責任**（§6.1）: `@ambit/core` はコンパイラ API に依存しない。`@ambit/checker` が接続層の情報で契約解析を行い、CLI とエディタで共用する。`@ambit/runtime` は本番依存で、コンパイラや CLI を持ち込まない。

**契約モデル**（§4）: 静的検査は関数単位、ランタイム強制はエントリポイント単位。`unknown` は中核概念で、禁止ではなく `--coverage` で可視化する。effects の伝播規則と標準エフェクト一覧は §4.2、capabilities の縮小則は §4.4、budget は「宣言・計測・遮断」であり静的保証しない（§4.5）。

**構造化診断**（§5）: 第一の消費者は AI エージェント。NDJSON、安定した診断 `id`、`fixes[].edits` は適用可能な具体的パッチのみ。契約を守る修正と緩める修正を `consistentWithContract` で区別する。

## 仕様編集時の約束

- 本仕様は Draft。Go 製ネイティブ TypeScript バックエンドは **候補** であり、§3.5 の検証ゲート通過まで採択済みと書かない。
- 「検証済み」と「未検証」を分ける記述を保つ。未実行のバックエンドに性能値を割り当てない。付録 A は M0.5 の予備検証であり完了ではない。
- RFC が必要な変更（§9）: 診断コードの意味、標準エフェクト、伝播規則、既定バックエンド、TypeScript 対応範囲の破壊的変更。
- 現在位置は M0（仕様レビュー）〜 M0.5（バックエンド比較）。マイルストーンは §11。
- 文章は日本語。README と DESIGN.md の文体・用語（effects / capabilities / budget / boundary / unknown は英語表記）に合わせる。
