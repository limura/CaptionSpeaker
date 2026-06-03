const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContentScriptEnvironment({ href = "https://www.youtube.com/watch?v=video123", evaluateResult, querySelectorMap, querySelectorAllMap, storageResult, fetchImpl, voices = [], setTimeoutImpl, clearTimeoutImpl, speechSynthesisImpl, speaking = false } = {}) {
  const codePath = path.join(__dirname, "..", "CaptionSpeaker", "contentScript.js");
  const source = fs.readFileSync(codePath, "utf8");

  const document = {
    body: {},
    evaluate(xpath) {
      if (evaluateResult) {
        return evaluateResult(xpath);
      }
      return {
        snapshotItem() {
          return null;
        }
      };
    },
    querySelector(selector) {
      return querySelectorMap?.[selector] ?? null;
    },
    querySelectorAll(selector) {
      return querySelectorAllMap?.[selector] ?? [];
    }
  };

  const chrome = {
    storage: {
      sync: {
        get(_keys, cb) {
          cb(storageResult ?? {});
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    runtime: {
      onMessage: {
        addListener() {}
      }
    }
  };

  // テストから観測するための記録領域
  const speech = { speak: [], cancel: 0, resume: 0, pause: 0, speaking };
  const speechSynthesis = speechSynthesisImpl ?? {
    getVoices() { return voices; },
    speak(utt) { speech.speak.push(utt); },
    cancel() { speech.cancel += 1; },
    resume() { speech.resume += 1; },
    pause() { speech.pause += 1; },
    get speaking() { return speech.speaking; }
  };
  const mutationObservers = [];
  const windowEventListeners = [];
  const fetchCalls = [];

  const context = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout: setTimeoutImpl ?? setTimeout,
    clearTimeout: clearTimeoutImpl ?? clearTimeout,
    fetch: fetchImpl ? ((...args) => { fetchCalls.push(args); return fetchImpl(...args); }) : undefined,
    URL,
    Promise,
    document,
    chrome,
    location: { href },
    window: {
      location: { href },
      navigator: { language: "ja-JP" },
      speechSynthesis,
      addEventListener(type, handler) { windowEventListeners.push({ type, handler }); }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        mutationObservers.push(this);
      }
      observe() {}
      disconnect() {}
    },
    XPathResult: {
      ORDERED_NODE_SNAPSHOT_TYPE: 7
    },
    SpeechSynthesisUtterance: function(text) {
      this.text = text;
    }
  };

  const wrapped = `${source}
module.exports = {
  state,
  GetVideoId,
  CaptionDataToTimeDict,
  IsTargetUrlWithOption,
  getTimedTextUrl,
  buildTimeTextsToCheck,
  shouldCheckCurrentVideo,
  isSpeechEnabled,
  normalizeSpeechText,
  applyVoiceSettingsToUtterance,
  buildCaptionSpeechText,
  getVoiceParameter,
  IsValidVideoDuration,
  stripLocaleSuffix,
  startsWithAny,
  findSelectedVoice,
  findLatestTimedTextUrl,
  filterTimedTextAccessUrls,
  setTimedTextLanguage,
  FormatTimeFromMillisecond,
  GuessVideoAutoTranslateOriginalLanguage,
  VideoLengthSecondsFromPlayerResponse,
  updateCaptionFetchMetadata,
  IsYoutubeUrl,
  clearCaptionData,
  shouldSkipCaptionFetchByLocale,
  applyFetchedCaptionData,
  consumeContentScriptLoadDelay,
  StorageResultToVoiceSettings,
  volumeOverride,
  volumeRecover,
  ensureOriginalVolume,
  getVideoPlaybackState,
  onUrlAccessed,
  shouldSkipTimedTextCollection,
  GetYtpVolumePanelValue,
  CheckCaptionIsDisplaying,
  fetchYoutubeJson,
  startSpeech,
  stopSpeechWithSpeakCheck,
  resumeSpeechIfMoviePlayerActive,
  AddSpeechQueue,
  CheckAndSpeech,
  checkCurrentVideoTimeTexts,
  CheckVideoCurrentTime,
  StartVideoTimeChecker,
  StopVideoTimeChecker,
  InitializeScreenObserver,
  KickToplevelObserver,
  SpeechAllWithoutSync,
  CheckPlayLocaleUpdate,
  LoadBooleanSettings,
  IsTargetUrl,
  attachVolumeRecoveryHandlers
};`;

  vm.runInNewContext(wrapped, context, { filename: "contentScript.js" });
  return {
    exports: context.module.exports,
    context,
    speech,
    mutationObservers,
    windowEventListeners,
    fetchCalls
  };
}

test("GetVideoId extracts watch, embed, and live ids", () => {
  assert.equal(loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc123&list=xyz" }).exports.GetVideoId(), "abc123");
  assert.equal(loadContentScriptEnvironment({ href: "https://www.youtube.com/embed/embed123?start=10" }).exports.GetVideoId(), "embed123");
  assert.equal(loadContentScriptEnvironment({ href: "https://www.youtube.com/live/live123?feature=share" }).exports.GetVideoId(), "live123");
});

test("CaptionDataToTimeDict strips supported HTML tags and skips blank captions", () => {
  const mod = loadContentScriptEnvironment().exports;
  const dict = mod.CaptionDataToTimeDict({
    events: [
      { tStartMs: 1000, segs: [{ utf8: "<b>Hello</b>" }, { utf8: " world" }] },
      { tStartMs: 2000, segs: [{ utf8: " \n" }] },
      { tStartMs: 62000, segs: [{ utf8: "<i>Second</i>" }] }
    ]
  });

  assert.deepEqual(Object.keys(dict), ["0:01", "1:02"]);
  assert.equal(dict["0:01"].segment, "Hello world");
  assert.equal(dict["1:02"].segment, "Second");
});

test("IsTargetUrlWithOption respects embedded-video setting", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.IsTargetUrlWithOption("https://www.youtube.com/watch?v=a", { isDisableSpeechEmbeddedSite: true }), true);
  assert.equal(mod.IsTargetUrlWithOption("https://www.youtube.com/live/a", { isDisableSpeechEmbeddedSite: true }), true);
  assert.equal(mod.IsTargetUrlWithOption("https://www.youtube.com/embed/a", { isDisableSpeechEmbeddedSite: true }), false);
  assert.equal(mod.IsTargetUrlWithOption("https://www.youtube.com/embed/a", { isDisableSpeechEmbeddedSite: false }), true);
});

test("getTimedTextUrl picks the latest matching timedtext url and replaces tlang", async () => {
  const loaded = loadContentScriptEnvironment();
  const mod = loaded.exports;
  mod.state.accessUrlList = [
    "https://www.youtube.com/api/timedtext?v=video123&lang=en",
    "https://www.youtube.com/api/timedtext?v=other999&lang=en",
    "https://www.youtube.com/api/timedtext?v=video123&lang=fr"
  ];
  mod.state.excludeAccessUrlList = ["https://www.youtube.com/api/timedtext?v=video123&lang=en"];
  const url = await mod.getTimedTextUrl("ja", "video123");
  assert.equal(url, "https://www.youtube.com/api/timedtext?v=video123&lang=fr&tlang=ja");
});

test("buildTimeTextsToCheck expands the load gap into second-aligned timestamps", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.deepEqual(Array.from(mod.buildTimeTextsToCheck(12.3, 2)), ["0:10", "0:11", "0:12"]);
  assert.deepEqual(Array.from(mod.buildTimeTextsToCheck(3.1, 0)), ["0:03"]);
});

test("shouldCheckCurrentVideo applies url, enabled, and sync-less guards together", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=video123" });
  const mod = loaded.exports;
  assert.equal(mod.shouldCheckCurrentVideo({}), true);
  assert.equal(mod.shouldCheckCurrentVideo({ isEnabled: false }), false);
  assert.equal(mod.shouldCheckCurrentVideo({ isSpeechWithoutSyncEnabled: true }), false);

  const embedLoaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/embed/video123" });
  assert.equal(embedLoaded.exports.shouldCheckCurrentVideo({ isDisableSpeechEmbeddedSite: true }), false);
});

test("isSpeechEnabled treats missing settings as enabled", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.isSpeechEnabled({}), true);
  assert.equal(mod.isSpeechEnabled({ isEnabled: true }), true);
  assert.equal(mod.isSpeechEnabled({ isEnabled: false }), false);
});

test("normalizeSpeechText replaces newlines with spaces", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.normalizeSpeechText("line1\nline2\nline3"), "line1 line2 line3");
});

test("applyVoiceSettingsToUtterance copies selected voice settings", () => {
  const mod = loadContentScriptEnvironment().exports;
  const utterance = {};
  const selectedVoice = { lang: "en-US", name: "TestVoice" };
  mod.applyVoiceSettingsToUtterance(utterance, {
    voiceVoice: selectedVoice,
    voicePitch: 1.2,
    voiceRate: 1.8,
    voiceVolume: 0.4
  });
  assert.equal(utterance.voice, selectedVoice);
  assert.equal(utterance.lang, "en-US");
  assert.equal(utterance.pitch, 1.2);
  assert.equal(utterance.rate, 1.8);
  assert.equal(utterance.volume, 0.4);
});

test("buildCaptionSpeechText concatenates captions in object iteration order", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.buildCaptionSpeechText({
    "0:01": { segment: "hello" },
    "0:02": { segment: "world" }
  }), " hello world");
});

test("getVoiceParameter falls back only when the stored value is falsy", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.getVoiceParameter(1.4, 1.0), 1.4);
  assert.equal(mod.getVoiceParameter(undefined, 1.0), 1.0);
  assert.equal(mod.getVoiceParameter("", 1.0), 1.0);
});

// videoLengthSeconds が前の動画の値のまま残ると、動画遷移後に発話判定が通らなくなる
// 問題(②)を IsValidVideoDuration の挙動で固定するテスト群。
// captionData は最後の字幕が 4:50 (tStartMs=290000) に出る、長さ約300秒の動画を表す。
const SAMPLE_CAPTION_DATA = {
  "0:01": { tStartMs: 1000 },
  "4:50": { tStartMs: 290000 }
};

test("IsValidVideoDuration accepts a duration close to videoLengthSeconds", () => {
  const loaded = loadContentScriptEnvironment();
  // 同じ動画相当(長さがほぼ一致)なら videoLengthSeconds による判定で有効になる
  loaded.exports.state.videoLengthSeconds = 300;
  assert.equal(loaded.exports.IsValidVideoDuration(300, SAMPLE_CAPTION_DATA), true);
});

test("IsValidVideoDuration rejects forever when videoLengthSeconds is stale from the previous video (bug #2 repro)", () => {
  const loaded = loadContentScriptEnvironment();
  // 前の動画(長さ600秒)の値が videoLengthSeconds に残ったまま、
  // 300秒の新しい動画に遷移した状況を再現する。
  loaded.exports.state.videoLengthSeconds = 600;
  // |600 - 300| >= 4 なので false になり、CheckVideoCurrentTime が発話に到達できず無音になる。
  assert.equal(loaded.exports.IsValidVideoDuration(300, SAMPLE_CAPTION_DATA), false);
});

test("IsValidVideoDuration falls back to caption timings when videoLengthSeconds is reset to -1", () => {
  const loaded = loadContentScriptEnvironment();
  // 動画遷移時に videoLengthSeconds を -1 へリセットした後の挙動(修正後に期待する状態)。
  loaded.exports.state.videoLengthSeconds = -1;
  // -1 のときは字幕の最終時刻(290秒)で判定するため、300秒の動画は再生可能と判定される。
  assert.equal(loaded.exports.IsValidVideoDuration(300, SAMPLE_CAPTION_DATA), true);
});

// --- リファクタで抽出・整理した小さな関数群のテスト ---

test("stripLocaleSuffix drops the region suffix", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.stripLocaleSuffix("ja-JP"), "ja");
  assert.equal(mod.stripLocaleSuffix("en-US"), "en");
  assert.equal(mod.stripLocaleSuffix("ja"), "ja");
  assert.equal(mod.stripLocaleSuffix(undefined), undefined);
});

test("startsWithAny matches only when a prefix is at the head", () => {
  const mod = loadContentScriptEnvironment().exports;
  const prefixes = ["https://www.youtube.com/watch?", "https://www.youtube.com/live/"];
  assert.equal(mod.startsWithAny("https://www.youtube.com/watch?v=a", prefixes), true);
  assert.equal(mod.startsWithAny("https://www.youtube.com/live/a", prefixes), true);
  assert.equal(mod.startsWithAny("https://www.youtube.com/embed/a", prefixes), false);
  assert.equal(mod.startsWithAny("https://example.com/watch?v=a", prefixes), false);
});

test("findSelectedVoice returns the voice matching both lang and name", () => {
  const mod = loadContentScriptEnvironment().exports;
  const voices = [
    { lang: "en-US", name: "Alice" },
    { lang: "ja-JP", name: "Haruka" }
  ];
  assert.equal(mod.findSelectedVoice(voices, "ja-JP", "Haruka"), voices[1]);
  assert.equal(mod.findSelectedVoice(voices, "ja-JP", "Alice"), undefined);
  assert.equal(mod.findSelectedVoice(voices, "fr-FR", "Haruka"), undefined);
});

test("filterTimedTextAccessUrls keeps only urls for the given video id", () => {
  const mod = loadContentScriptEnvironment().exports;
  const urls = [
    "https://www.youtube.com/api/timedtext?v=abc&lang=en",
    "https://www.youtube.com/api/timedtext?v=xyz&lang=en",
    "https://www.youtube.com/api/timedtext?v=abc&lang=fr"
  ];
  assert.deepEqual(mod.filterTimedTextAccessUrls(urls, "abc"), [urls[0], urls[2]]);
  assert.deepEqual(mod.filterTimedTextAccessUrls(urls, "none"), []);
});

test("findLatestTimedTextUrl returns the last matching, non-excluded url", () => {
  const mod = loadContentScriptEnvironment().exports;
  const urls = [
    "https://www.youtube.com/api/timedtext?v=abc&lang=en",
    "https://www.youtube.com/api/timedtext?v=abc&lang=fr",
    undefined,
    "https://www.youtube.com/api/timedtext?v=xyz&lang=en"
  ];
  const excluded = ["https://www.youtube.com/api/timedtext?v=abc&lang=fr"];
  // fr は除外済み、xyz は対象外なので、最後に残る abc&lang=en が返る
  assert.equal(mod.findLatestTimedTextUrl(urls, excluded, "abc"), urls[0]);
  assert.equal(mod.findLatestTimedTextUrl(urls, [], "none"), undefined);
});

test("setTimedTextLanguage sets or overwrites the tlang parameter", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(
    mod.setTimedTextLanguage("https://www.youtube.com/api/timedtext?v=abc&lang=en", "ja"),
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=ja"
  );
  assert.equal(
    mod.setTimedTextLanguage("https://www.youtube.com/api/timedtext?v=abc&tlang=fr", "ja"),
    "https://www.youtube.com/api/timedtext?v=abc&tlang=ja"
  );
  // パースできないURLはそのまま返す
  assert.equal(mod.setTimedTextLanguage("not a url", "ja"), "not a url");
});

test("FormatTimeFromMillisecond formats m:ss and h:mm:ss", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.FormatTimeFromMillisecond(1000), "0:01");
  assert.equal(mod.FormatTimeFromMillisecond(62000), "1:02");
  assert.equal(mod.FormatTimeFromMillisecond(3661000), "1:01:01");
});

test("VideoLengthSecondsFromPlayerResponse reads videoDetails.lengthSeconds", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.VideoLengthSecondsFromPlayerResponse({ videoDetails: { lengthSeconds: "300" } }), "300");
  assert.equal(mod.VideoLengthSecondsFromPlayerResponse({}), undefined);
  assert.equal(mod.VideoLengthSecondsFromPlayerResponse(undefined), undefined);
});

function playerResponseWithTracks(captionTracks){
  return { captions: { playerCaptionsTracklistRenderer: { captionTracks } } };
}

test("GuessVideoAutoTranslateOriginalLanguage prefers the asr track", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(
    mod.GuessVideoAutoTranslateOriginalLanguage(playerResponseWithTracks([
      { languageCode: "ja" },
      { kind: "asr", languageCode: "en" }
    ])),
    "en"
  );
});

test("GuessVideoAutoTranslateOriginalLanguage falls back to the first track when no asr track exists", () => {
  const mod = loadContentScriptEnvironment().exports;
  // asr が無い場合は先頭トラックの言語にフォールバックする(旧実装は undefined を返していた不具合)
  assert.equal(
    mod.GuessVideoAutoTranslateOriginalLanguage(playerResponseWithTracks([
      { languageCode: "ja" },
      { languageCode: "fr" }
    ])),
    "ja"
  );
});

test("GuessVideoAutoTranslateOriginalLanguage returns undefined without caption tracks", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.GuessVideoAutoTranslateOriginalLanguage(playerResponseWithTracks([])), undefined);
  assert.equal(mod.GuessVideoAutoTranslateOriginalLanguage({}), undefined);
  assert.equal(mod.GuessVideoAutoTranslateOriginalLanguage(undefined), undefined);
});

// SPA遷移で player_response が前の動画のままになると、videoLengthSeconds に別動画の長さが
// 入って IsValidVideoDuration が false 固着し、切替先の動画が発話しなくなる不具合への対策。
test("updateCaptionFetchMetadata ignores player_response for a different video", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=current1" });
  const mod = loaded.exports;
  mod.state.videoLengthSeconds = -1;
  // 別動画(SPA遷移前の動画)の player_response → videoLengthSeconds を汚染しない
  mod.updateCaptionFetchMetadata({ videoDetails: { videoId: "previous9", lengthSeconds: "1468" } });
  assert.equal(mod.state.videoLengthSeconds, -1);
});

test("updateCaptionFetchMetadata adopts length only for the current video", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=current1" });
  const mod = loaded.exports;
  mod.state.videoLengthSeconds = -1;
  // 現在の動画の player_response → videoLengthSeconds を採用
  mod.updateCaptionFetchMetadata({ videoDetails: { videoId: "current1", lengthSeconds: "838" } });
  assert.equal(mod.state.videoLengthSeconds, "838");
});

test("updateCaptionFetchMetadata leaves length untouched when player_response is missing", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=current1" });
  const mod = loaded.exports;
  mod.state.videoLengthSeconds = -1;
  mod.updateCaptionFetchMetadata(undefined);
  assert.equal(mod.state.videoLengthSeconds, -1);
});

// --- セキュリティガード: 外部由来URLを fetch 前に youtube.com かどうか確認する(F-4) ---

test("IsYoutubeUrl accepts only https youtube.com hosts", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.IsYoutubeUrl("https://www.youtube.com/api/timedtext?v=a"), true);
  assert.equal(mod.IsYoutubeUrl("https://youtube.com/watch?v=a"), true);
  // 相対URLは現在のページ(youtube.com)を基準に解決されるので true
  assert.equal(mod.IsYoutubeUrl("/api/timedtext?v=a"), true);
});

test("IsYoutubeUrl rejects non-https, other hosts, and lookalike subdomains", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.IsYoutubeUrl("http://www.youtube.com/a"), false);   // https でない
  assert.equal(mod.IsYoutubeUrl("https://evil.com/a"), false);          // 別ホスト
  assert.equal(mod.IsYoutubeUrl("https://www.youtube.com.evil.com/a"), false); // なりすまし
  assert.equal(mod.IsYoutubeUrl("https://notyoutube.com/a"), false);
  assert.equal(mod.IsYoutubeUrl("javascript:alert(1)"), false);         // 危険なスキーム
  assert.equal(mod.IsYoutubeUrl("ftp://youtube.com/a"), false);         // https 以外のスキーム
});

// --- 字幕辞書/状態系のヘルパー ---

test("clearCaptionData resets the caption dictionary", () => {
  const mod = loadContentScriptEnvironment().exports;
  mod.state.captionData = { "0:01": { segment: "x" } };
  mod.clearCaptionData();
  assert.equal(Object.keys(mod.state.captionData).length, 0);
});

test("applyFetchedCaptionData stores the caption dict and current video id", () => {
  const mod = loadContentScriptEnvironment().exports;
  mod.applyFetchedCaptionData({ events: [{ tStartMs: 1000, segs: [{ utf8: "hello" }] }] }, "vid9");
  assert.equal(mod.state.currentVideoId, "vid9");
  assert.deepEqual(Object.keys(mod.state.captionData), ["0:01"]);
  assert.equal(mod.state.captionData["0:01"].segment, "hello");
});

test("shouldSkipCaptionFetchByLocale only skips when guessed lang matches and option is on", () => {
  const mod = loadContentScriptEnvironment().exports;
  mod.state.playLocale = "ja";
  mod.state.guessedOriginalCaptionLanguage = "ja";
  assert.equal(mod.shouldSkipCaptionFetchByLocale({ isDisableSpeechIfSameLocaleVideo: true }), true);
  assert.equal(mod.shouldSkipCaptionFetchByLocale({ isDisableSpeechIfSameLocaleVideo: false }), false);
  mod.state.guessedOriginalCaptionLanguage = "en";
  assert.equal(mod.shouldSkipCaptionFetchByLocale({ isDisableSpeechIfSameLocaleVideo: true }), false);
});

test("consumeContentScriptLoadDelay returns the elapsed seconds once, then clears", () => {
  const mod = loadContentScriptEnvironment().exports;
  // 未設定なら 0.0
  mod.state.contentScriptLoadTime = undefined;
  assert.equal(mod.consumeContentScriptLoadDelay(), 0.0);
  // 約2秒前に読み込まれた想定 → 正の遅延を返し、読み取り後は undefined になる
  mod.state.contentScriptLoadTime = new Date(Date.now() - 2000);
  const delay = mod.consumeContentScriptLoadDelay();
  assert.ok(delay >= 1.0 && delay < 10, `delay ${delay} should be a few seconds`);
  assert.equal(mod.state.contentScriptLoadTime, undefined);
});

test("StorageResultToVoiceSettings applies defaults when nothing is stored", () => {
  const mod = loadContentScriptEnvironment().exports;
  const setting = mod.StorageResultToVoiceSettings({});
  assert.equal(setting.voicePitch, 1.0);
  assert.equal(setting.voiceRate, 1.6);
  assert.equal(setting.voiceVolume, 1.0);
  assert.equal(setting.voiceVoice, undefined);
  assert.equal(setting.isStopIfNewSpeech, false);
});

test("StorageResultToVoiceSettings carries stored values through", () => {
  const mod = loadContentScriptEnvironment().exports;
  const setting = mod.StorageResultToVoiceSettings({ pitch: 0.8, rate: 2.0, volume: 0.3, isStopIfNewSpeech: 1 });
  assert.equal(setting.voicePitch, 0.8);
  assert.equal(setting.voiceRate, 2.0);
  assert.equal(setting.voiceVolume, 0.3);
  assert.equal(setting.isStopIfNewSpeech, true);
});

// --- 元動画の音量上書き(開始+1/終了-1 の参照カウント) ---

test("volumeOverride/volumeRecover use a reference count and clamp volume to [0,1]", () => {
  const mod = loadContentScriptEnvironment().exports;
  const video = { volume: 1 };
  mod.state.overrideVolumeCount = 0;

  mod.volumeOverride(video, 0.8, 0.5);   // 0.8 * 0.5 = 0.4
  assert.equal(mod.state.overrideVolumeCount, 1);
  assert.equal(video.volume, 0.4);

  mod.volumeOverride(video, 0.8, 2.0);   // 0.8 * 2.0 = 1.6 → 1 にクランプ
  assert.equal(mod.state.overrideVolumeCount, 2);
  assert.equal(video.volume, 1);

  mod.volumeRecover(video, 0.8);         // カウントが残っている間は戻さない
  assert.equal(mod.state.overrideVolumeCount, 1);
  assert.equal(video.volume, 1);

  mod.volumeRecover(video, 0.8);         // 0 以下で元の音量へ戻す
  assert.equal(mod.state.overrideVolumeCount, 0);
  assert.equal(video.volume, 0.8);
});

test("ensureOriginalVolume captures the volume only on first call", () => {
  const mod = loadContentScriptEnvironment().exports;
  mod.state.originalVolume = undefined;
  mod.ensureOriginalVolume({ volume: 0.5 });
  assert.equal(mod.state.originalVolume, 0.5);
  // 2回目以降は上書きしない
  mod.ensureOriginalVolume({ volume: 0.9 });
  assert.equal(mod.state.originalVolume, 0.5);
});

test("getVideoPlaybackState reports whether the duration is known", () => {
  const mod = loadContentScriptEnvironment().exports;
  const known = mod.getVideoPlaybackState({ currentTime: 5, duration: 100 });
  assert.equal(known.currentTime, 5);
  assert.equal(known.duration, 100);
  assert.equal(known.isDurationKnown, true);

  const unknown = mod.getVideoPlaybackState({ currentTime: 5, duration: NaN });
  assert.equal(unknown.isDurationKnown, false);
});

// --- background から渡される timedtext URL の収集 ---

test("onUrlAccessed collects timedtext urls and ignores others/excluded", () => {
  const mod = loadContentScriptEnvironment().exports;
  mod.state.accessUrlList = [];
  mod.state.excludeAccessUrlList = [];

  mod.onUrlAccessed("https://www.youtube.com/api/timedtext?v=a&lang=en");
  assert.deepEqual(mod.state.accessUrlList, ["https://www.youtube.com/api/timedtext?v=a&lang=en"]);

  // timedtext でないURLは無視
  mod.onUrlAccessed("https://www.youtube.com/watch?v=a");
  assert.equal(mod.state.accessUrlList.length, 1);

  // 除外リストにあるURLは収集しない
  mod.state.excludeAccessUrlList = ["https://www.youtube.com/api/timedtext?v=b"];
  mod.onUrlAccessed("https://www.youtube.com/api/timedtext?v=b");
  assert.equal(mod.state.accessUrlList.length, 1);
});

// --- CaptionDataToTimeDict の追加ケース ---

test("CaptionDataToTimeDict concatenates segments and strips multiple inline tags", () => {
  const mod = loadContentScriptEnvironment().exports;
  const dict = mod.CaptionDataToTimeDict({
    events: [
      { tStartMs: 0, segs: [{ utf8: "<b>a</b>" }, { utf8: "b" }, { utf8: "<i>c</i>" }] }
    ]
  });
  assert.equal(dict["0:00"].segment, "abc");
});

test("CaptionDataToTimeDict returns undefined when events are missing", () => {
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.CaptionDataToTimeDict({}), undefined);
  assert.equal(mod.CaptionDataToTimeDict(undefined), undefined);
});

// --- DOM 依存: document.evaluate(XPath) の戻りを差し替えて検証する ---
// xpath に含まれる部分文字列でノードを引けるようにする評価モックを作る。
function evaluateByXPathSubstring(pairs) {
  return (xpath) => {
    for (const [needle, node] of pairs) {
      if (xpath.includes(needle)) {
        return { snapshotItem: () => node };
      }
    }
    return { snapshotItem: () => null };
  };
}

function attrNode(attrs) {
  return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
}

test("shouldSkipTimedTextCollection skips when an ad is playing", () => {
  const mod = loadContentScriptEnvironment({
    querySelectorAllMap: { "#ytd-player .video-ads": [{ childNodes: { length: 1 } }] }
  }).exports;
  assert.equal(mod.shouldSkipTimedTextCollection("v"), true);
});

test("shouldSkipTimedTextCollection skips when there is no subtitle button", () => {
  // 字幕ボタンの XPath に対して null を返す(=ボタンが無い)
  const mod = loadContentScriptEnvironment().exports;
  assert.equal(mod.shouldSkipTimedTextCollection("v"), true);
});

test("shouldSkipTimedTextCollection skips when the subtitle button is not a real toggle (no captions)", () => {
  // aria-pressed 属性が無い = 字幕が無い動画
  const mod = loadContentScriptEnvironment({
    evaluateResult: evaluateByXPathSubstring([["ytp-subtitles-button", attrNode({})]])
  }).exports;
  assert.equal(mod.shouldSkipTimedTextCollection("v"), true);
});

test("shouldSkipTimedTextCollection does not skip when captions are available", () => {
  // aria-pressed があり、広告も無く、字幕ボタンも存在する → 収集してよい
  const mod = loadContentScriptEnvironment({
    evaluateResult: evaluateByXPathSubstring([["ytp-subtitles-button", attrNode({ "aria-pressed": "false" })]])
  }).exports;
  assert.equal(mod.shouldSkipTimedTextCollection("v"), false);
});

test("CheckCaptionIsDisplaying reflects the subtitle button aria-pressed state", () => {
  const on = loadContentScriptEnvironment({
    evaluateResult: evaluateByXPathSubstring([["ytp-subtitles-button", attrNode({ "aria-pressed": "true" })]])
  }).exports;
  assert.equal(on.CheckCaptionIsDisplaying(), true);

  const off = loadContentScriptEnvironment({
    evaluateResult: evaluateByXPathSubstring([["ytp-subtitles-button", attrNode({ "aria-pressed": "false" })]])
  }).exports;
  assert.equal(off.CheckCaptionIsDisplaying(), false);

  // ボタンが無ければ false
  assert.equal(loadContentScriptEnvironment().exports.CheckCaptionIsDisplaying(), false);
});

test("GetYtpVolumePanelValue reads the HTML volume panel and clamps to [0,1]", () => {
  const half = loadContentScriptEnvironment({
    evaluateResult: evaluateByXPathSubstring([["ytp-volume-area", { value: 50 }]])
  }).exports;
  assert.equal(half.GetYtpVolumePanelValue(0.7), 0.5);

  const over = loadContentScriptEnvironment({
    evaluateResult: evaluateByXPathSubstring([["ytp-volume-area", { value: 150 }]])
  }).exports;
  assert.equal(over.GetYtpVolumePanelValue(0.7), 1);

  // パネルが読めない(ノード無し)場合は fallback を返す
  assert.equal(loadContentScriptEnvironment().exports.GetYtpVolumePanelValue(0.7), 0.7);
});

// =========================================================================
// 非同期/副作用層: fetch・発話ディスパッチ・オブザーバ/タイマー
// =========================================================================

function mockResponse({ ok = true, status = 200, body = "" }) {
  return { ok, status, text: async () => body };
}

const TIMEDTEXT_URL = "https://www.youtube.com/api/timedtext?v=a&lang=en";

test("fetchYoutubeJson refuses non-youtube urls without fetching (SSRF guard)", async () => {
  const loaded = loadContentScriptEnvironment({ fetchImpl: () => { throw new Error("should not fetch"); } });
  assert.equal(await loaded.exports.fetchYoutubeJson("https://evil.com/x"), undefined);
  assert.equal(loaded.fetchCalls.length, 0);
});

test("fetchYoutubeJson skips urls already in the exclude list", async () => {
  const loaded = loadContentScriptEnvironment({ fetchImpl: () => { throw new Error("should not fetch"); } });
  loaded.exports.state.excludeAccessUrlList = [TIMEDTEXT_URL];
  assert.equal(await loaded.exports.fetchYoutubeJson(TIMEDTEXT_URL), undefined);
  assert.equal(loaded.fetchCalls.length, 0);
});

test("fetchYoutubeJson parses JSON on success and records the fetched url", async () => {
  const loaded = loadContentScriptEnvironment({ fetchImpl: async () => mockResponse({ body: '{"events":[]}' }) });
  loaded.exports.state.excludeAccessUrlList = [];
  const result = await loaded.exports.fetchYoutubeJson(TIMEDTEXT_URL);
  assert.deepEqual(Object.keys(result), ["events"]);
  assert.ok(loaded.exports.state.excludeAccessUrlList.includes(TIMEDTEXT_URL));
});

test("fetchYoutubeJson returns undefined for non-ok responses, bad JSON, and fetch errors", async () => {
  const notOk = loadContentScriptEnvironment({ fetchImpl: async () => mockResponse({ ok: false, status: 404 }) });
  notOk.exports.state.excludeAccessUrlList = [];
  assert.equal(await notOk.exports.fetchYoutubeJson(TIMEDTEXT_URL), undefined);

  const badJson = loadContentScriptEnvironment({ fetchImpl: async () => mockResponse({ body: "not json" }) });
  badJson.exports.state.excludeAccessUrlList = [];
  assert.equal(await badJson.exports.fetchYoutubeJson(TIMEDTEXT_URL), undefined);

  const threw = loadContentScriptEnvironment({ fetchImpl: async () => { throw new Error("network"); } });
  threw.exports.state.excludeAccessUrlList = [];
  assert.equal(await threw.exports.fetchYoutubeJson(TIMEDTEXT_URL), undefined);
});

// --- 発話開始/停止のガード(別URLからの cancel 誤爆防止) ---

function fakeSpeech() {
  return { spoken: [], cancelled: 0, speak(u) { this.spoken.push(u); }, cancel() { this.cancelled += 1; } };
}

test("startSpeech remembers the speak-target url and dispatches speak", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc" });
  const ss = fakeSpeech();
  const utt = { text: "hi" };
  loaded.exports.startSpeech(ss, utt);
  assert.equal(loaded.exports.state.speakTargetUrl, "https://www.youtube.com/watch?v=abc");
  assert.equal(ss.spoken[0], utt);
});

test("stopSpeechWithSpeakCheck cancels only when the speak-target url matches the current url", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc" });
  const ss = fakeSpeech();
  loaded.exports.state.speakTargetUrl = "https://www.youtube.com/watch?v=abc"; // 一致 → cancel
  loaded.exports.stopSpeechWithSpeakCheck(ss);
  assert.equal(ss.cancelled, 1);
  loaded.exports.state.speakTargetUrl = "https://www.youtube.com/watch?v=OTHER"; // 不一致 → cancel しない
  loaded.exports.stopSpeechWithSpeakCheck(ss);
  assert.equal(ss.cancelled, 1);
});

// --- 発話ディスパッチ ---

test("AddSpeechQueue dispatches an utterance with newline-normalized text", () => {
  const loaded = loadContentScriptEnvironment();
  loaded.exports.AddSpeechQueue("line1\nline2", {}, null);
  assert.equal(loaded.speech.speak.length, 1);
  assert.equal(loaded.speech.speak[0].text, "line1 line2");
});

test("CheckAndSpeech speaks the caption at the time and dedups by prevSpeakTime", () => {
  const loaded = loadContentScriptEnvironment();
  loaded.exports.state.captionData = { "0:05": { segment: "hello" } };
  loaded.exports.state.prevSpeakTime = "";
  loaded.exports.CheckAndSpeech("0:05", {}, null);
  assert.equal(loaded.speech.speak.length, 1);
  assert.equal(loaded.speech.speak[0].text, "hello");
  assert.equal(loaded.exports.state.prevSpeakTime, "0:05");
  loaded.exports.CheckAndSpeech("0:05", {}, null); // 同じ時刻 → 重複しない
  assert.equal(loaded.speech.speak.length, 1);
});

test("CheckAndSpeech stays silent when there is no caption at the time", () => {
  const loaded = loadContentScriptEnvironment();
  loaded.exports.state.captionData = { "0:05": { segment: "hello" } };
  loaded.exports.CheckAndSpeech("0:09", {}, null);
  assert.equal(loaded.speech.speak.length, 0);
});

test("CheckAndSpeech honors isDisableSpeechIfChaptionDisabled when captions are hidden", () => {
  const loaded = loadContentScriptEnvironment(); // 字幕ボタン無し → 表示なし扱い
  loaded.exports.state.captionData = { "0:05": { segment: "hello" } };
  loaded.exports.CheckAndSpeech("0:05", { isDisableSpeechIfChaptionDisabled: true }, null);
  assert.equal(loaded.speech.speak.length, 0);
});

test("checkCurrentVideoTimeTexts speaks the caption for the reached second", () => {
  const loaded = loadContentScriptEnvironment();
  loaded.exports.state.captionData = { "0:05": { segment: "five" } };
  loaded.exports.state.prevCheckVideoTimeText = "";
  loaded.exports.state.prevSpeakTime = "";
  loaded.exports.checkCurrentVideoTimeTexts(5.4, 0, {}, null); // 5.4s → "0:05"
  assert.equal(loaded.speech.speak.length, 1);
  assert.equal(loaded.speech.speak[0].text, "five");
});

// --- 再生位置チェックの一気通貫 ---

test("CheckVideoCurrentTime speaks the caption at the current playback time", async () => {
  const video = { currentTime: 5, duration: 100, volume: 1 };
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    storageResult: {},
    evaluateResult: evaluateByXPathSubstring([["html5-main-video", video]])
  });
  loaded.exports.state.captionData = { "0:05": { segment: "hello" } };
  loaded.exports.state.videoLengthSeconds = 100;
  loaded.exports.state.prevCheckVideoTimeText = "";
  loaded.exports.state.prevSpeakTime = "";
  await loaded.exports.CheckVideoCurrentTime(0);
  assert.equal(loaded.speech.speak.length, 1);
  assert.equal(loaded.speech.speak[0].text, "hello");
});

test("CheckVideoCurrentTime stays silent when the duration looks invalid", async () => {
  const video = { currentTime: 5, duration: 100, volume: 1 };
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    storageResult: {},
    evaluateResult: evaluateByXPathSubstring([["html5-main-video", video]])
  });
  loaded.exports.state.captionData = { "0:05": { segment: "hello" } };
  loaded.exports.state.videoLengthSeconds = 999; // duration(100) と食い違う
  await loaded.exports.CheckVideoCurrentTime(0);
  assert.equal(loaded.speech.speak.length, 0);
});

// --- タイマー(setTimeout を注入して実タイマーを使わない) ---

test("StartVideoTimeChecker reschedules itself every 250ms", () => {
  const scheduled = [];
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    setTimeoutImpl: (fn, ms) => { scheduled.push(ms); return 1; },
    clearTimeoutImpl: () => {}
  });
  loaded.exports.StartVideoTimeChecker();
  assert.deepEqual(scheduled, [250]);
});

test("StopVideoTimeChecker clears the scheduled timer id", () => {
  const cleared = [];
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    setTimeoutImpl: () => 777,
    clearTimeoutImpl: (id) => { cleared.push(id); }
  });
  loaded.exports.StartVideoTimeChecker();
  loaded.exports.StopVideoTimeChecker();
  assert.deepEqual(cleared, [777]);
});

// --- プレイヤー状態オブザーバ(screenObserver) ---

const MOVIE_PLAYER_SELECTOR = "#movie_player[class*='html5-video-player']";

test("resumeSpeechIfMoviePlayerActive resumes only when the player is in playing-mode", () => {
  const playing = loadContentScriptEnvironment({
    querySelectorMap: { [MOVIE_PLAYER_SELECTOR]: { classList: { contains: (c) => c === "playing-mode" } } }
  });
  playing.exports.state.paused = true;
  playing.exports.resumeSpeechIfMoviePlayerActive();
  assert.equal(playing.exports.state.paused, false);
  assert.equal(playing.speech.resume, 1);

  const idle = loadContentScriptEnvironment();
  idle.exports.resumeSpeechIfMoviePlayerActive();
  assert.equal(idle.speech.resume, 0);
});

test("InitializeScreenObserver registers a blur handler that cancels speech while paused", () => {
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    querySelectorMap: { [MOVIE_PLAYER_SELECTOR]: { classList: { contains: () => false } } }
  });
  const blur = loaded.windowEventListeners.filter((l) => l.type === "blur");
  assert.ok(blur.length >= 1);
  loaded.exports.state.paused = true;
  loaded.exports.state.speakTargetUrl = loaded.context.location.href;
  blur[0].handler({});
  assert.ok(loaded.speech.cancel >= 1);
});

test("screenObserver pauses speech when the player enters paused-mode", () => {
  const loaded = loadContentScriptEnvironment();
  const screenObserver = loaded.mutationObservers[0];
  loaded.speech.speaking = true;
  loaded.exports.state.paused = false;
  const target = { classList: { contains: (c) => c === "paused-mode" }, querySelector: () => ({ currentTime: 42 }) };
  screenObserver.callback([{ target }]);
  assert.equal(loaded.exports.state.paused, true);
  assert.equal(loaded.exports.state.pauseTime, 42);
  assert.equal(loaded.speech.pause, 1);
});

test("screenObserver resumes speech when un-pausing at nearly the same time", () => {
  const loaded = loadContentScriptEnvironment();
  const screenObserver = loaded.mutationObservers[0];
  loaded.exports.state.paused = true;
  loaded.exports.state.pauseTime = 42;
  const target = { classList: { contains: (c) => c === "playing-mode" }, querySelector: () => ({ currentTime: 42.3 }) };
  screenObserver.callback([{ target }]);
  assert.equal(loaded.exports.state.paused, false);
  assert.equal(loaded.speech.resume, 1);
});

test("screenObserver cancels speech when un-pausing after a seek", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc" });
  const screenObserver = loaded.mutationObservers[0];
  loaded.exports.state.paused = true;
  loaded.exports.state.pauseTime = 42;
  loaded.exports.state.speakTargetUrl = loaded.context.location.href;
  const target = { classList: { contains: (c) => c === "playing-mode" }, querySelector: () => ({ currentTime: 100 }) };
  screenObserver.callback([{ target }]);
  assert.equal(loaded.exports.state.paused, false);
  assert.ok(loaded.speech.cancel >= 1);
});

test("screenObserver cancels speech when the video src changes", () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc" });
  const screenObserver = loaded.mutationObservers[0];
  loaded.exports.state.speakTargetUrl = loaded.context.location.href;
  screenObserver.callback([{ attributeName: "src", target: {} }]);
  assert.ok(loaded.speech.cancel >= 1);
});

// --- トップレベルオブザーバ(SPA遷移検知) ---

test("KickToplevelObserver installs a mutation observer", async () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc", storageResult: {} });
  const before = loaded.mutationObservers.length;
  await loaded.exports.KickToplevelObserver();
  assert.ok(loaded.mutationObservers.length > before);
});

// --- 同期せず全文を一度に読み上げるモード(isSpeechWithoutSyncEnabled) ---

test("SpeechAllWithoutSync reads the entire transcript in a single utterance", async () => {
  const video = { currentTime: 0, duration: 100, volume: 1 };
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    storageResult: {},
    evaluateResult: evaluateByXPathSubstring([["html5-main-video", video]])
  });
  loaded.exports.state.captionData = { "0:01": { segment: "hello" }, "0:05": { segment: "world" } };
  loaded.exports.state.videoLengthSeconds = 100;
  await loaded.exports.SpeechAllWithoutSync();
  assert.equal(loaded.speech.speak.length, 1);
  assert.equal(loaded.speech.speak[0].text.trim(), "hello world");
});

test("SpeechAllWithoutSync stays silent when speech is disabled", async () => {
  const video = { currentTime: 0, duration: 100, volume: 1 };
  const loaded = loadContentScriptEnvironment({
    href: "https://www.youtube.com/watch?v=abc",
    storageResult: { isEnabled: false },
    evaluateResult: evaluateByXPathSubstring([["html5-main-video", video]])
  });
  loaded.exports.state.captionData = { "0:01": { segment: "hello" } };
  loaded.exports.state.videoLengthSeconds = 100;
  await loaded.exports.SpeechAllWithoutSync();
  assert.equal(loaded.speech.speak.length, 0);
});

// --- 選んだ音声から再生ロケールを同期する ---

test("CheckPlayLocaleUpdate sets the play locale from the stored matching voice", async () => {
  const loaded = loadContentScriptEnvironment({
    storageResult: { lang: "en-US", voice: "Alice" },
    voices: [{ lang: "en-US", name: "Alice" }]
  });
  loaded.exports.state.playLocale = "ja";
  await loaded.exports.CheckPlayLocaleUpdate();
  assert.equal(loaded.exports.state.playLocale, "en");
});

test("CheckPlayLocaleUpdate leaves the locale unchanged when no voice matches", async () => {
  const loaded = loadContentScriptEnvironment({
    storageResult: { lang: "en-US", voice: "Nobody" },
    voices: [{ lang: "en-US", name: "Alice" }]
  });
  loaded.exports.state.playLocale = "ja";
  await loaded.exports.CheckPlayLocaleUpdate();
  assert.equal(loaded.exports.state.playLocale, "ja");
});

// --- 有効/無効の反映 ---

test("LoadBooleanSettings cancels speech when disabled", async () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc", storageResult: { isEnabled: false } });
  loaded.exports.state.speakTargetUrl = loaded.context.location.href;
  await loaded.exports.LoadBooleanSettings();
  assert.ok(loaded.speech.cancel >= 1);
});

test("LoadBooleanSettings does not cancel when enabled", async () => {
  const loaded = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc", storageResult: { isEnabled: true } });
  loaded.exports.state.speakTargetUrl = loaded.context.location.href;
  await loaded.exports.LoadBooleanSettings();
  assert.equal(loaded.speech.cancel, 0);
});

// --- 対象URL判定(設定込み)の async ラッパー ---

test("IsTargetUrl resolves the target-url decision from storage", async () => {
  const watch = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc", storageResult: {} });
  assert.equal(await watch.exports.IsTargetUrl(), true);

  const embedDisabled = loadContentScriptEnvironment({ href: "https://www.youtube.com/embed/abc", storageResult: { isDisableSpeechEmbeddedSite: true } });
  assert.equal(await embedDisabled.exports.IsTargetUrl(), false);
});

// --- 発話中だけ元動画の音量を下げ、終了で戻す配線 ---

test("attachVolumeRecoveryHandlers does nothing unless override is enabled", () => {
  const loaded = loadContentScriptEnvironment();
  loaded.exports.state.originalVolume = 0.8;
  const utt = {};
  const video = { volume: 0.8 };
  loaded.exports.attachVolumeRecoveryHandlers(utt, { isOverrideOriginalVolumeEnabled: false }, video);
  assert.equal(utt.onend, undefined);
  assert.equal(video.volume, 0.8);
});

test("attachVolumeRecoveryHandlers lowers the video volume and restores it on utterance end", () => {
  const loaded = loadContentScriptEnvironment();
  loaded.exports.state.originalVolume = 0.8;
  loaded.exports.state.overrideVolumeCount = 0;
  const utt = {};
  const video = { volume: 0.8 };
  // パネルノードが無いので GetYtpVolumePanelValue は fallback(=0.8) を返す → 0.8*0.25=0.2
  loaded.exports.attachVolumeRecoveryHandlers(utt, { isOverrideOriginalVolumeEnabled: true, overrideOriginalVolumeMagnification: 0.25 }, video);
  assert.equal(video.volume, 0.2);
  assert.equal(typeof utt.onend, "function");
  utt.onend(); // 発話終了 → カウント0 → 元の音量へ
  assert.equal(video.volume, 0.8);
});
