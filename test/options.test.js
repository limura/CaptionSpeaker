const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// options.js を vm で読み込み、純粋な関数群と設定キーの定数を取り出して検証する。
// options.js は読み込み時に getElementById / querySelectorAll / speechSynthesis に
// 触れるため、それらを最小限モックしておく。
function loadOptionsEnvironment() {
  const codePath = path.join(__dirname, "..", "CaptionSpeaker", "options.js");
  const source = fs.readFileSync(codePath, "utf8");

  const document = {
    getElementById() {
      // 読み込み時の configureShortcuts.onclick 代入などを通すためのダミー要素
      return { onclick: null, addEventListener() {}, style: {} };
    },
    querySelectorAll() {
      return [];
    }
  };

  const chrome = {
    i18n: { getMessage() { return ""; } },
    storage: { sync: { get() {}, set() {}, remove() {} } },
    runtime: { sendMessage() {} },
    tabs: { update() {} }
  };

  const context = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    Promise,
    Set,
    Array,
    Math,
    document,
    chrome,
    location: { reload() {} },
    window: {
      speechSynthesis: {
        onvoiceschanged: null,
        getVoices() { return []; }
      }
    }
  };

  const wrapped = `${source}
module.exports = {
  BOOLEAN_SETTING_IDS,
  ALL_SETTING_KEYS,
  getVoiceLangueges,
  filterVoiceForLang,
  getVoiceNames,
  searchVoiceFromName
};`;

  vm.runInNewContext(wrapped, context, { filename: "options.js" });
  return context.module.exports;
}

const SAMPLE_VOICES = [
  { lang: "ja-JP", name: "Haruka" },
  { lang: "ja-JP", name: "Ichiro" },
  { lang: "en-US", name: "Alice" }
];

// vm コンテキスト内で生成された配列はプロトタイプが主実行系と異なるため、
// deepStrictEqual で比較する前にスプレッドで主実行系の配列へ変換する。
test("getVoiceLangueges returns the unique set of languages", () => {
  const mod = loadOptionsEnvironment();
  assert.deepEqual([...mod.getVoiceLangueges(SAMPLE_VOICES)], ["ja-JP", "en-US"]);
  assert.deepEqual([...mod.getVoiceLangueges([])], []);
});

test("filterVoiceForLang keeps only voices of the given language", () => {
  const mod = loadOptionsEnvironment();
  assert.deepEqual([...mod.filterVoiceForLang(SAMPLE_VOICES, "ja-JP")], [SAMPLE_VOICES[0], SAMPLE_VOICES[1]]);
  assert.deepEqual([...mod.filterVoiceForLang(SAMPLE_VOICES, "fr-FR")], []);
});

test("getVoiceNames returns the unique set of voice names", () => {
  const mod = loadOptionsEnvironment();
  assert.deepEqual([...mod.getVoiceNames(SAMPLE_VOICES)], ["Haruka", "Ichiro", "Alice"]);
});

test("searchVoiceFromName finds a voice by name", () => {
  const mod = loadOptionsEnvironment();
  assert.equal(mod.searchVoiceFromName(SAMPLE_VOICES, "Ichiro"), SAMPLE_VOICES[1]);
  assert.equal(mod.searchVoiceFromName(SAMPLE_VOICES, "Nobody"), undefined);
});

test("ALL_SETTING_KEYS contains every boolean setting and the value settings", () => {
  const mod = loadOptionsEnvironment();
  // boolean 設定はすべて ALL_SETTING_KEYS に含まれていること(save/load/clear の一貫性)
  for (const id of mod.BOOLEAN_SETTING_IDS) {
    assert.ok(mod.ALL_SETTING_KEYS.includes(id), `${id} should be in ALL_SETTING_KEYS`);
  }
  // 数値・選択系の設定も含まれていること
  for (const key of ["lang", "voice", "pitch", "rate", "volume", "overrideOriginalVolumeMagnification"]) {
    assert.ok(mod.ALL_SETTING_KEYS.includes(key), `${key} should be in ALL_SETTING_KEYS`);
  }
  // 以前リセット漏れしていた isSpeechWithoutSyncEnabled が含まれていること
  assert.ok(mod.ALL_SETTING_KEYS.includes("isSpeechWithoutSyncEnabled"));
});
