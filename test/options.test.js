const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// options.js を vm で読み込み、純粋な関数群と設定キーの定数を取り出して検証する。
// options.js は読み込み時に getElementById / querySelectorAll / speechSynthesis に
// 触れるため、それらを最小限モックしておく。
function loadOptionsEnvironment({ elements, i18nMessages } = {}) {
  const codePath = path.join(__dirname, "..", "CaptionSpeaker", "options.js");
  const source = fs.readFileSync(codePath, "utf8");

  const document = {
    getElementById(id) {
      if (elements && id in elements) {
        return elements[id];
      }
      // 読み込み時の configureShortcuts.onclick 代入などを通すためのダミー要素
      return { onclick: null, addEventListener() {}, style: {} };
    },
    querySelectorAll() {
      return [];
    }
  };

  const chrome = {
    i18n: { getMessage(key) { return i18nMessages?.[key] ?? ""; } },
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
  searchVoiceFromName,
  selectSelected,
  getTestText,
  getLang,
  getVoice,
  getCheckboxFlag
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

test("selectSelected marks the option whose value matches", () => {
  const mod = loadOptionsEnvironment();
  const select = { options: [
    { value: "a", selected: false },
    { value: "b", selected: false },
    { value: "c", selected: false }
  ] };
  mod.selectSelected(select, "b");
  assert.equal(select.options[0].selected, false);
  assert.equal(select.options[1].selected, true);
  assert.equal(select.options[2].selected, false);
});

test("getTestText falls back from textarea to i18n to a built-in default", () => {
  // 入力がある場合はそれを使う
  const typed = loadOptionsEnvironment({ elements: { testText: { value: "hello" } } });
  assert.equal(typed.getTestText(), "hello");

  // 入力が空なら i18n メッセージを使う
  const i18n = loadOptionsEnvironment({
    elements: { testText: { value: "" } },
    i18nMessages: { OptionsPageSampleTextValue: "サンプル文" }
  });
  assert.equal(i18n.getTestText(), "サンプル文");

  // どちらも空なら組み込みの既定文(空でない)を返す
  const fallback = loadOptionsEnvironment({ elements: { testText: { value: "" } } });
  assert.ok(fallback.getTestText().length > 0);
});

test("getLang returns undefined for DEFAULT and the value otherwise", () => {
  const def = loadOptionsEnvironment({ elements: { lang: { value: "DEFAULT" } } });
  assert.equal(def.getLang([]), undefined);

  const ja = loadOptionsEnvironment({ elements: { lang: { value: "ja-JP" } } });
  assert.equal(ja.getLang([]), "ja-JP");
});

test("getVoice resolves the selected voice by name unless lang is DEFAULT", () => {
  const voices = [{ lang: "ja-JP", name: "Haruka" }, { lang: "en-US", name: "Alice" }];

  const def = loadOptionsEnvironment({ elements: { lang: { value: "DEFAULT" }, voice: { value: "Haruka" } } });
  assert.equal(def.getVoice(voices), undefined);

  const picked = loadOptionsEnvironment({ elements: { lang: { value: "ja-JP" }, voice: { value: "Haruka" } } });
  assert.equal(picked.getVoice(voices), voices[0]);
});

test("getCheckboxFlag returns 1 for checked and 0 for unchecked", () => {
  const on = loadOptionsEnvironment({ elements: { isStopIfNewSpeech: { checked: true } } });
  assert.equal(on.getCheckboxFlag("isStopIfNewSpeech"), 1);

  const off = loadOptionsEnvironment({ elements: { isStopIfNewSpeech: { checked: false } } });
  assert.equal(off.getCheckboxFlag("isStopIfNewSpeech"), 0);
});
