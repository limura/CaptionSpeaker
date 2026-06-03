const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// background.js を vm で読み込み、純粋なロジック関数を取り出して検証する。
// background.js は読み込み時に各種 chrome.* のリスナー登録などを行うため、
// それらを no-op でモックしておく(storage.sync.get はコールバックを呼ばない)。
function loadBackgroundEnvironment() {
  const codePath = path.join(__dirname, "..", "CaptionSpeaker", "background.js");
  const source = fs.readFileSync(codePath, "utf8");

  const noop = () => {};
  const listener = { addListener: noop };
  const chrome = {
    action: { onClicked: listener, setIcon: noop },
    tabs: { onActivated: listener, query: noop, sendMessage: noop },
    runtime: { onMessage: listener, openOptionsPage: noop, sendMessage: noop },
    commands: { onCommand: listener },
    storage: { sync: { get: noop, set: noop } },
    webRequest: { onCompleted: listener }
  };

  const context = {
    module: { exports: {} },
    exports: {},
    console,
    Number,
    chrome
  };

  const wrapped = `${source}
module.exports = { shouldOpenOptionsForLegacyData };`;

  vm.runInNewContext(wrapped, context, { filename: "background.js" });
  return context.module.exports;
}

test("shouldOpenOptionsForLegacyData opens options for missing or invalid rate", () => {
  const mod = loadBackgroundEnvironment();
  // 未設定/不正値 → 設定ページを開く(true)
  assert.equal(mod.shouldOpenOptionsForLegacyData({}), true);
  assert.equal(mod.shouldOpenOptionsForLegacyData({ rate: 1.6 }), true);   // 数値(文字列でない)
  assert.equal(mod.shouldOpenOptionsForLegacyData({ rate: "0" }), true);   // 0以下
  assert.equal(mod.shouldOpenOptionsForLegacyData({ rate: "11" }), true);  // 10超
  // 正常な文字列の rate → 開かない(false)
  assert.equal(mod.shouldOpenOptionsForLegacyData({ rate: "1.6" }), false);
  assert.equal(mod.shouldOpenOptionsForLegacyData({ rate: "10" }), false);
});
