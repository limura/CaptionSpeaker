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
    optionElement.innerHTML = name;
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

function getIsStopIfNewSpeech(){
  return document.getElementById("isStopIfNewSpeech").checked;
}

function getIsDisableSpeechIfSameLocaleVideo(){
  return document.getElementById("isDisableSpeechIfSameLocaleVideo").checked;
}

function getTestText(){
  let text = document.getElementById("testText").value;
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
    "rate", utterance.pitch,
    "volume", utterance.pitch);

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
  chrome.storage.sync.set({
    "pitch": getPitch(),
    "rate": getRate(),
    "volume": getVolume(),
    "isStopIfNewSpeech": getIsStopIfNewSpeech(),
    "isDisableSpeechIfSameLocaleVideo": getIsDisableSpeechIfSameLocaleVideo()
  });
  chrome.runtime.sendMessage({"type": "SettingsUpdated"});

  savedInformationElement.innerHTML = "saved!";
  setTimeout(function(){
    savedInformationElement.innerHTML = "";
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
  chrome.storage.sync.get(["lang", "voice", "pitch", "rate", "volume"], (storage)=>{
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
    if(rateValue >= 2.0){
      document.getElementById("isRateMaxStrech").checked = true;
      rate.max = 10;
    }
    rate.value = rateValue;
    document.getElementById("rateValue").innerHTML = rateValue;
  }
  if("volume" in storage){
    document.getElementById("volume").value = storage.volume;
  }
  if("isStopIfNewSpeech" in storage){
    document.getElementById("isStopIfNewSpeech").checked = storage.isStopIfNewSpeech;
  }
  if("isDisableSpeechIfSameLocaleVideo" in storage){
    document.getElementById("isDisableSpeechIfSameLocaleVideo").checked = storage.isDisableSpeechIfSameLocaleVideo;
  }
  });
}

function clearSettings(){
  chrome.storage.sync.remove(["lang", "voice", "pitch", "rate", "volume", "isStopIfNewSpeech", "isDisableSpeechIfSameLocaleVideo"]);
  location.reload();
}

function createVoiceSelectElement(parentElement, voices, targetLang){
  let voiceNames = getVoiceNames(filterVoiceForLang(voices, targetLang));
  parentElement.innerHTML = '';
  parentElement.appendChild(createSelectElement(voiceNames, "voice", function(element){}));
}

function initRateValueWatcher(inputIdentity, valueIdentity){
  let input = document.getElementById(inputIdentity);
  let value = document.getElementById(valueIdentity);
  input.addEventListener('input', () => {
    value.innerHTML = input.value;
  });
  input.addEventListener('change', () => {
    value.innerHTML = input.value;
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
        value.innerHTML = "2";
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
  langElement.innerHTML = '';
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
  initRateValueWatcher("rate", "rateValue");
  initRateMaxStrechExtension("rate", "rateValue", "isRateMaxStrech", "isRateMaxStrechWarningText");
  loadSettings(voices);
};

document.getElementById('configureShortcuts').onclick = function(e) {
  chrome.tabs.update({ url: 'chrome://extensions/shortcuts' });
};

const awaitVoices = new Promise(resolve => speechSynthesis.onvoiceschanged = resolve);
awaitVoices.then(()=>{init();});

localizeHtmlPage();
