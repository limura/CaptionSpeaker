# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

（このリポジトリの開発者は日本語話者です。応答・説明・新規ドキュメントはすべて日本語で記述してください。）

## 概要

CaptionSpeaker は、YouTube の字幕を Web Speech API（`speechSynthesis`）で読み上げる Manifest V3 の Chrome 拡張機能です。動画にユーザーが選んだ音声の言語の字幕があるとき、再生に同期して字幕を読み上げ、字幕を「耳で聞ける」ようにします。Chrome ウェブストアで公開されています。

ディレクトリ構成が入れ子になっている点に注意してください。リポジトリ直下にはツール・テスト・ドキュメントが置かれ、実際に配布する拡張機能本体は [CaptionSpeaker/](CaptionSpeaker/) サブディレクトリ（manifest・各スクリプト・ロケール・アイコン）にあります。直下の `CaptionSpeaker.zip` はパッケージ済みの成果物です。

## コマンド

```sh
npm test                                              # テスト全体を実行 (node --test)
node --test --test-name-pattern="GetVideoId"          # 名前を指定して単一テストを実行
./makeZip.sh                                           # ウェブストア提出用に CaptionSpeaker.zip を再生成
```

テストは Node 組み込みのテストランナーだけで動きます。依存パッケージはインストール不要です（`package.json` に依存関係はありません）。

ブラウザで動作確認する場合: `chrome://extensions` を開き、デベロッパーモードを有効にして「パッケージ化されていない拡張機能を読み込む」から [CaptionSpeaker/](CaptionSpeaker/) ディレクトリを読み込み、YouTube の動画を開きます。chrome-devtools-mcp を使ったテスト手順と注意点はプロジェクトメモリを参照してください。

## アーキテクチャ

3 つの実行コンテキストが `chrome.storage.sync` を介して状態を共有します。

- **[CaptionSpeaker/background.js](CaptionSpeaker/background.js)**（Service Worker）— ツールバーのアクションを管理します。クリックすると `isEnabled` フラグを切り替え、アイコンを差し替えます（明色 = ON、暗色 = OFF）。`enableEvent`/`disableEvent` のキーボードコマンドも処理します。重要な点として、`youtube.com/api/timedtext*` に対する `chrome.webRequest.onCompleted` リスナーを動かしており、観測した URL を `url_accessed` メッセージとしてコンテンツスクリプトに転送します。これは、コンテンツスクリプトが自力で組み立てられない字幕 URL を発見するための仕組みです。
- **[CaptionSpeaker/contentScript.js](CaptionSpeaker/contentScript.js)** — `*://*.youtube.com/*` の**すべてのフレーム**に注入されます（埋め込みプレイヤーでも動くようにするため）。ロジックの約 95% がここにあります。字幕の取得、再生に同期した読み上げ、YouTube の SPA 遷移への対応を担います。
- **[CaptionSpeaker/options.html](CaptionSpeaker/options.html) + [options.js](CaptionSpeaker/options.js)** — 設定ページです。`chrome.storage.sync` を読み書きし、`SettingsUpdated` のランタイムメッセージでアクティブなタブに変更を通知します。音声一覧は `speechSynthesis.getVoices()` から取得します（`onvoiceschanged` イベントで利用可能になります）。

設定はすべて `chrome.storage.sync` に保存され、コンテンツスクリプトは `chrome.storage.onChanged` で変更にリアルタイムに反応します。主なフラグ: `isEnabled`、`lang`/`voice`/`pitch`/`rate`/`volume`、`isStopIfNewSpeech`、`isDisableSpeechIfSameLocaleVideo`、`isDisableSpeechIfChaptionDisabled`、`isDisableSpeechEmbeddedSite`、`isOverrideOriginalVolumeEnabled`/`overrideOriginalVolumeMagnification`、`isSpeechWithoutSyncEnabled`。

### 字幕の取得 — 2 つの方式とフォールバック

`FetchCaptionData` が入口です。次の順で試します。

1. **`FetchCaptionDataFromPlayerResponse`** — インラインの `ytcfg.set({...})` スクリプトから `INNERTUBE_API_KEY` を抜き出し、`youtubei/v1/player` に POST して `captions.playerCaptionsTracklistRenderer.captionTracks` を読み取ります。`GetCaptionDataUrl` はロケールが完全一致するトラックを優先し、なければ先頭トラックに `&tlang=<locale>` を付けて YouTube の自動翻訳を要求します。**この解析は意図的に脆い**作りです（`GetYoutbeiV1PlayerData` の長いコメントを参照）。YouTube の JS シリアライズ形式（`ytcfg.set({` … `});window.ytcfg.obfuscatedData_`）に正確に依存しているため、YouTube 側の形式変更が最も多い故障原因です。
2. **`FetchCaptionDataFromTimedText`** — フォールバックです。background が `url_accessed` で集めて `accessUrlList` に溜めた URL に依存します。まだ 1 つも観測できていない場合は、字幕ボタンをクリックして（`doubleClickWithDelay`）YouTube 自身の UI に `timedtext` URL を取得させ、その後 `tlang` パラメータを書き換えます。`shouldSkipTimedTextCollection` は字幕のない動画（例: ライブ配信）で字幕ボタンを延々と押し続けないようにします。

取得した JSON は `CaptionDataToTimeDict` で `"m:ss"` のタイムスタンプをキーとする辞書 `{tStartMs, segment, time}` に正規化されます。1 行分のセグメントを連結し、インラインの HTML タグ（`<b>`、`<i>` など）を除去します。

### 再生との同期

`StartVideoTimeChecker` が 250ms ごとにポーリングし → `CheckVideoCurrentTime` が `video.currentTime` を `"m:ss"` 形式にして字幕辞書を引き、新しく到達したセグメントを `AddSpeechQueue` で読み上げます。`prevSpeakTime`/`prevCheckVideoTimeText` で重複を防ぎます。別モードの `isSpeechWithoutSyncEnabled`（`SpeechAllWithoutSync`）は同期せずにトランスクリプト全体を一度に読み上げます。

### YouTube の SPA 遷移とプレイヤー状態

YouTube はチャンネル → 視聴ページの遷移時に通常のナビゲーションイベントを発火しないため、2 つの `MutationObserver` で補います。

- **`ToplevelObserver`**（`document.body` を監視）— URL・動画 ID の変化を検知し、字幕の再取得と時間チェッカーを再起動します。
- **`screenObserver`**（`#movie_player` を監視）— class や `src` の変化を見て、プレイヤーの状態（一時停止・シーク・動画切り替え）に合わせて読み上げを一時停止・再開・キャンセルします。

`speakTargetUrl` は `speechSynthesis.cancel()` をガードし、古いフレームが現在の URL の読み上げをキャンセルしてしまわないようにします。

## 規約と制約

- **コード内のコメントは日本語です。** 既存ファイルを編集するときはそれに合わせてください。
- **テストはコンテンツスクリプトを `vm.runInNewContext` で読み込みます**（[test/contentScript.test.js](test/contentScript.test.js)）。ソース文字列の末尾に内部関数を列挙した `module.exports = { … }` を付け足し、手作りでモックした `document`/`window`/`chrome` の上で実行します。関数をテスト可能にするには、`contentScript.js` 内で**トップレベルの `function` 宣言**である必要があり（入れ子や `var` に代入したアロー関数は不可）、その export 一覧に追加します。スクリプトが触るブラウザのグローバルは `loadContentScriptEnvironment` 内でモックする必要があります。
- **セキュリティ方針（v2.0.12 以降）:** コンテンツスクリプトと host 権限は `youtube.com` のみに限定しています。`IsYoutubeUrl` は外部由来の URL を `fetch` する前に必ずガードしなければなりません（SSRF 対策）。コンソール出力は `debugLog`/`CS_DEBUG`（既定で OFF）を通し、視聴 URL や字幕本文が漏れないようにしています。これらのガードは維持してください。
- **ローカライズ:** `CaptionSpeaker/_locales/{en,ja,zh_CN,zh_TW}/messages.json`、`default_locale` は `en` です。UI 文字列は manifest 内では `__MSG_key__`、HTML では `data-i18n-text`/`data-i18n-value` 属性を使い、`localizeHtmlPage()` が `chrome.i18n.getMessage` で解決します。新しい文字列はすべてのロケールに追加してください。
- **バージョニング:** リリースごとに [CaptionSpeaker/manifest.json](CaptionSpeaker/manifest.json) の `version` を上げ、[README.md](README.md) の更新履歴セクションに対応する `## Version x.y.z` の項目（日本語の変更履歴）を追記します。
