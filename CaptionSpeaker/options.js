// 設定キーの単一の情報源。保存(save)・読み込み(load)・リセット(clear)で共通利用する。
// チェックボックス系(0/1で保存)はループで一括処理する。
const BOOLEAN_SETTING_IDS = [
  "isStopIfNewSpeech",
  "isDisableSpeechIfSameLocaleVideo",
  "isDisableSpeechIfChaptionDisabled",
  "isDisableSpeechEmbeddedSite",
  "isOverrideOriginalVolumeEnabled",
  "isSpeechWithoutSyncEnabled",
];
// lang/voice/rate/overrideOriginalVolumeMagnification は読み込み時に個別処理が必要。
const ALL_SETTING_KEYS = [
  "lang", "voice", "pitch", "rate", "volume",
  ...BOOLEAN_SETTING_IDS,
  "overrideOriginalVolumeMagnification",
];

function localizeHtmlPage() {
  document.querySelectorAll("[data-i18n-text]").forEach(element => {
    const key = element.getAttribute("data-i18n-text");
    element.textContent = chrome.i18n.getMessage(key);
  });

  document.querySelectorAll("[data-i18n-value]").forEach(element => {
    const key = element.getAttribute("data-i18n-value");
    element.value = chrome.i18n.getMessage(key);
  });
}

function getVoiceList(speechSynthesis) {
  let voices = speechSynthesis.getVoices();
  return voices;
}

function getVoiceLangueges(voices) {
  var langSet = new Set();
  for(let voice of voices){
    if("lang" in voice){
      langSet.add(voice.lang);
    }
  }
  return Array.from(langSet.values());
}

function filterVoiceForLang(voices, lang) {
  var result = [];
  for(let voice of voices){
    if("lang" in voice && voice.lang == lang){
      result.push(voice);
    }
  }
  return result;
} 
function getVoiceNames(voices) {
  var resultSet = new Set();
  for(let voice of voices){
    if("name" in voice){
      resultSet.add(voice.name);
    }
  }
  return Array.from(resultSet.values());
}

function searchVoiceFromName(voices, name){
  for(let voice of voices){
    if("name" in voice && voice.name == name){
      return voice;
    }
  }
  return undefined;
}

function createSelectElement(nameArray, selectorId, onChangeFunction){
  let selectElement = document.createElement("select");
  selectElement.id = selectorId;
  for(let name of nameArray){
    let optionElement = document.createElement("option");
    optionElement.value = name;
    optionElement.textContent = name;
    selectElement.appendChild(optionElement);
  }
  selectElement.onchange = function(){
    onChangeFunction(selectElement);
  };
  return selectElement;
}

function getLang(voices){
  let lang = document.getElementById("lang").value;
  if(lang == "DEFAULT"){
    return undefined;
  }
  return lang;
}

function getVoice(voices){
  let lang = document.getElementById("lang").value;
  if(lang == "DEFAULT"){
    return undefined;
  }
  let voiceName = document.getElementById("voice").value;
  return searchVoiceFromName(voices, voiceName);
}

function getPitch(){
  return document.getElementById("pitch").value;
}

function getRate(){
  return document.getElementById("rate").value;
}

function getVolume(){
  return document.getElementById("volume").value;
}

// チェックボックスの状態を 0/1 で取得します。
function getCheckboxFlag(id){
  return document.getElementById(id).checked ? 1 : 0;
}

function getOverrideOriginalVolumeMagnification(){
  return document.getElementById("overrideOriginalVolumeMagnification").value;
}

function getTestText(){
  var text = document.getElementById("testText").value;
  if(!text){
    text = chrome.i18n.getMessage("OptionsPageSampleTextValue");
  }
  if(!text){
    return "メロスは激怒した。必ず、かのじゃちぼうぎゃくの王を除かなければならぬと決意した。";
  }
  return text;
}

function testButtonClicked(speechSynthesis, voices){
  speechSynthesis.cancel();
  let testText = getTestText();
  let utterance = new SpeechSynthesisUtterance(testText);
  let lang = getLang(voices);
  if(lang){
    utterance.lang = lang;
  }
  let voice = getVoice(voices);
  if(voice){
    utterance.voice = voice;
  }
  utterance.pitch = getPitch();
  utterance.rate = getRate();
  utterance.volume = getVolume();

  console.log(testText,
    "lang", lang,
    "voice", voice,
    "pitch", utterance.pitch,
    "rate", utterance.rate,
    "volume", utterance.volume);

  speechSynthesis.speak(utterance);
}

function saveButtonClicked(voices, savedInformationElement){
  let lang = getLang(voices);
  if(lang){
    chrome.storage.sync.set({"lang":lang});
  }else{
    chrome.storage.sync.remove(["lang"]);
  }
  let voice = getVoice(voices);
  if(voice){
    chrome.storage.sync.set({"voice":voice.name});
  }else{
    chrome.storage.sync.remove(["voice"]);
  }
  const values = {
    "pitch": getPitch(),
    "rate": getRate(),
    "volume": getVolume(),
    "overrideOriginalVolumeMagnification": getOverrideOriginalVolumeMagnification(),
  };
  for(const id of BOOLEAN_SETTING_IDS){
    values[id] = getCheckboxFlag(id);
  }
  chrome.storage.sync.set(values);
  chrome.runtime.sendMessage({"type": "SettingsUpdated"});

  savedInformationElement.textContent = "saved!";
  setTimeout(function(){
    savedInformationElement.textContent = "";
  }, 1000);
}

function selectSelected(selectElement, targetValue){
  for(var i = 0; i < selectElement.options.length; i++){
    let option = selectElement.options[i];
    let value = option.value;
    if(value == targetValue){
      option.selected = true;
      return;
    }
  }
}

function loadSettings(voices){
  chrome.storage.sync.get(ALL_SETTING_KEYS, (storage)=>{
  if("lang" in storage){
    let lang = storage.lang;
    selectSelected(document.getElementById("langSelector").childNodes[0], lang);
    let voiceSelectorElement = document.getElementById("voiceSelector");
    createVoiceSelectElement(voiceSelectorElement, voices, lang);
  }
  if("voice" in storage){
    selectSelected(document.getElementById("voiceSelector").childNodes[0], storage.voice);
  }
  if("pitch" in storage){
    document.getElementById("pitch").value = storage.pitch;
  }
  if("rate" in storage){
    let rateValue = storage.rate;
    let rate = document.getElementById("rate");
    if(rateValue > 2.0){
      document.getElementById("isRateMaxStrech").checked = true;
      rate.max = 10;
    }
    rate.value = rateValue;
    document.getElementById("rateValue").textContent = rateValue;
  }
  if("volume" in storage){
    document.getElementById("volume").value = storage.volume;
  }
  for(const id of BOOLEAN_SETTING_IDS){
    if(id in storage){
      document.getElementById(id).checked = storage[id] ? true : false;
    }
  }
  if("overrideOriginalVolumeMagnification" in storage){
    const mag = Math.max(0, Math.min(1, storage.overrideOriginalVolumeMagnification));
    document.getElementById("overrideOriginalVolumeMagnification").value = mag;
    document.getElementById("overrideOriginalVolumeMagnificationValue").textContent = mag;
  }
  });
}

function clearSettings(){
  // ALL_SETTING_KEYS を使うことで保存対象を1箇所で管理する。
  // (以前は isSpeechWithoutSyncEnabled がこのリストから漏れており、リセットしても残っていた)
  chrome.storage.sync.remove(ALL_SETTING_KEYS);
  location.reload();
}

function createVoiceSelectElement(parentElement, voices, targetLang){
  let voiceNames = getVoiceNames(filterVoiceForLang(voices, targetLang));
  parentElement.textContent = '';
  parentElement.appendChild(createSelectElement(voiceNames, "voice", function(element){}));
}

function initValueSliderWatcher(inputIdentity, valueIdentity){
  let input = document.getElementById(inputIdentity);
  let value = document.getElementById(valueIdentity);
  input.addEventListener('input', () => {
    value.textContent = input.value;
  });
  input.addEventListener('change', () => {
    value.textContent = input.value;
  });
}

function initRateMaxStrechExtension(rateId, valueId, toggleId, warningId){
  let toggle = document.getElementById(toggleId);
  let warning = document.getElementById(warningId);
  let rate = document.getElementById(rateId);
  let value = document.getElementById(valueId);
  toggle.addEventListener('change', () => {
    if(toggle.checked){
      warning.style.display = "block";
      rate.max = 10;
    }else{
      warning.style.display = "none";
      if(rate.value > 2){
        rate.value = 2;
        value.textContent = "2";
      }
      rate.max = 2;
    }
  });
}

let speechSynthesis = window.speechSynthesis;
function init(){
  let voices = getVoiceList(speechSynthesis);
  let languageNameArray = ["DEFAULT"].concat(getVoiceLangueges(voices));
  let langElement = document.getElementById("langSelector");
  langElement.textContent = '';
  langElement.appendChild(createSelectElement(languageNameArray, "lang", function(element){
    let index = element.selectedIndex;
    let lang = element.options[index].value;
    let voiceSelectorElement = document.getElementById("voiceSelector");
    createVoiceSelectElement(voiceSelectorElement, voices, lang);
  }));

  document.getElementById("voiceSelectorTest").onclick = function(){
    testButtonClicked(speechSynthesis, voices);
  };
  let savedInformationElement = document.getElementById("savedInfomation");
  document.getElementById("save").onclick = function(){
    saveButtonClicked(voices, savedInformationElement);
  };
  document.getElementById("voiceSettingReset").onclick = clearSettings;
  initValueSliderWatcher("rate", "rateValue");
  initRateMaxStrechExtension("rate", "rateValue", "isRateMaxStrech", "isRateMaxStrechWarningText");
  initValueSliderWatcher("overrideOriginalVolumeMagnification", "overrideOriginalVolumeMagnificationValue");
  loadSettings(voices);
};

document.getElementById('configureShortcuts').onclick = function(e) {
  chrome.tabs.update({ url: 'chrome://extensions/shortcuts' });
};

const awaitVoices = new Promise(resolve => speechSynthesis.onvoiceschanged = resolve);
awaitVoices.then(()=>{init();});

localizeHtmlPage();
