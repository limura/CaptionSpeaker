const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContentScriptEnvironment({ href = "https://www.youtube.com/watch?v=video123", evaluateResult, querySelectorMap } = {}) {
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
    querySelectorAll() {
      return [];
    }
  };

  const chrome = {
    storage: {
      sync: {
        get(_keys, cb) {
          cb({});
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

  const context = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    URL,
    Promise,
    document,
    chrome,
    location: { href },
    window: {
      location: { href },
      navigator: { language: "ja-JP" },
      speechSynthesis: {
        getVoices() {
          return [];
        },
        speak() {},
        cancel() {},
        resume() {},
        pause() {},
        speaking: false
      },
      addEventListener() {}
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
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
  GetVideoId,
  GenerateYoutbeiV1PlayerPostPayload,
  GetCaptionDataUrl,
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
  IsValidVideoDuration
};`;

  vm.runInNewContext(wrapped, context, { filename: "contentScript.js" });
  return {
    exports: context.module.exports,
    context
  };
}

test("GetVideoId extracts watch, embed, and live ids", () => {
  assert.equal(loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=abc123&list=xyz" }).exports.GetVideoId(), "abc123");
  assert.equal(loadContentScriptEnvironment({ href: "https://www.youtube.com/embed/embed123?start=10" }).exports.GetVideoId(), "embed123");
  assert.equal(loadContentScriptEnvironment({ href: "https://www.youtube.com/live/live123?feature=share" }).exports.GetVideoId(), "live123");
});

test("GenerateYoutbeiV1PlayerPostPayload uses video id from the current url", () => {
  const mod = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=payload123" }).exports;
  const payload = JSON.parse(mod.GenerateYoutbeiV1PlayerPostPayload({ INNERTUBE_CONTEXT: { client: { hl: "ja" } } }));
  assert.deepEqual(payload, {
    context: { client: { hl: "ja" } },
    videoId: "payload123"
  });
});

test("GetCaptionDataUrl prefers an exact locale track and falls back to translated captions", async () => {
  const mod = loadContentScriptEnvironment({ href: "https://www.youtube.com/watch?v=video123" }).exports;
  const directUrl = await mod.GetCaptionDataUrl({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "ja-JP", baseUrl: "https://example.com/direct" },
          { languageCode: "en", baseUrl: "https://example.com/fallback" }
        ]
      }
    }
  });
  assert.equal(directUrl, "https://example.com/direct&fmt=json3");

  const fallbackUrl = await mod.GetCaptionDataUrl({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", baseUrl: "https://example.com/base,a" }
        ]
      }
    }
  });
  assert.equal(fallbackUrl, "https://example.com/base%2Ca&fmt=json3&xorb=2&xobt=3&xovt=3&tlang=ja-JP");
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
  loaded.context.accessUrlList = [
    "https://www.youtube.com/api/timedtext?v=video123&lang=en",
    "https://www.youtube.com/api/timedtext?v=other999&lang=en",
    "https://www.youtube.com/api/timedtext?v=video123&lang=fr"
  ];
  loaded.context.excludeAccessUrlList = ["https://www.youtube.com/api/timedtext?v=video123&lang=en"];
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
  loaded.context.videoLengthSeconds = 300;
  assert.equal(loaded.exports.IsValidVideoDuration(300, SAMPLE_CAPTION_DATA), true);
});

test("IsValidVideoDuration rejects forever when videoLengthSeconds is stale from the previous video (bug #2 repro)", () => {
  const loaded = loadContentScriptEnvironment();
  // 前の動画(長さ600秒)の値が videoLengthSeconds に残ったまま、
  // 300秒の新しい動画に遷移した状況を再現する。
  loaded.context.videoLengthSeconds = 600;
  // |600 - 300| >= 4 なので false になり、CheckVideoCurrentTime が発話に到達できず無音になる。
  assert.equal(loaded.exports.IsValidVideoDuration(300, SAMPLE_CAPTION_DATA), false);
});

test("IsValidVideoDuration falls back to caption timings when videoLengthSeconds is reset to -1", () => {
  const loaded = loadContentScriptEnvironment();
  // 動画遷移時に videoLengthSeconds を -1 へリセットした後の挙動(修正後に期待する状態)。
  loaded.context.videoLengthSeconds = -1;
  // -1 のときは字幕の最終時刻(290秒)で判定するため、300秒の動画は再生可能と判定される。
  assert.equal(loaded.exports.IsValidVideoDuration(300, SAMPLE_CAPTION_DATA), true);
});
