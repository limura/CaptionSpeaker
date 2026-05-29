let speechSynthesis = window.speechSynthesis;
var prevSpeakTime = "";
var playLocale = window.navigator.language;
var captionData = {};
var videoLengthSeconds = -1;
var guessedOriginalCaptionLanguage = undefined;
var CURRENT_VIDEO_ID = "invalid video id!";
var prevCheckVideoTimeText = "";
var originalVolume = undefined;

var ContentScriptLoadTime = new Date();
var speakTargetUrl = undefined;

const YOUTUBE_UI_SELECTORS = {
  configScriptXPath: "//script[@nonce and contains(text(),'INNERTUBE_API_KEY')]",
  initialPlayerResponseXPath: "//script[@nonce and contains(text(),'var ytInitialPlayerResponse')]",
  subtitlesButtonXPath: "//button[contains(@class,'ytp-subtitles-button')]|//button[@class='ytmClosedCaptioningButtonButton']",
  videoXPath: "//video[contains(@class,'html5-main-video')]",
  volumeXPath: "//span[@class='ytp-volume-area']/div[@aria-valuenow]/@aria-valuenow",
  moviePlayerSelector: "#movie_player[class*='html5-video-player']",
  playPauseButtonSelector: "button.player-control-play-pause-icon",
  videoAdsSelector: "#ytd-player .video-ads",
  videoStreamSelector: ".video-stream"
};

const CAPTION_FETCH_STORAGE_KEYS = ["isEnabled", "isDisableSpeechIfSameLocaleVideo", "isSpeechWithoutSyncEnabled"];
const VIDEO_TIME_CHECK_STORAGE_KEYS = ["isEnabled", "isDisableSpeechIfChaptionDisabled", "lang", "voice", "pitch", "rate", "volume", "isStopIfNewSpeech", "isDisableSpeechEmbeddedSite", "isOverrideOriginalVolumeEnabled", "overrideOriginalVolumeMagnification", "isSpeechWithoutSyncEnabled"];

function getFirstSnapshotNode(xpath, contextNode = document){
  return document.evaluate(xpath, contextNode, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0);
}

function getMoviePlayerElement(){
  return document.querySelector(YOUTUBE_UI_SELECTORS.moviePlayerSelector);
}

function getMainVideoElement(){
  return getFirstSnapshotNode(YOUTUBE_UI_SELECTORS.videoXPath);
}

function getSubtitleButtonElement(){
  return getFirstSnapshotNode(YOUTUBE_UI_SELECTORS.subtitlesButtonXPath);
}

function isSpeechEnabled(storageResult){
  return storageResult?.isEnabled || typeof storageResult?.isEnabled == "undefined";
}

function filterTimedTextAccessUrls(urlList, videoId) {
  return urlList.filter((url) => url.includes(`/timedtext?v=${videoId}`));
}

function findLatestTimedTextUrl(urlList, excludedUrls, videoId) {
  let latestUrl = undefined;
  for (const currentUrl of urlList) {
    if (!currentUrl) {
      continue;
    }
    if (excludedUrls.includes(currentUrl)) {
      continue;
    }
    if (!currentUrl.includes(`/timedtext?v=${videoId}`)) {
      continue;
    }
    latestUrl = currentUrl;
  }
  return latestUrl;
}

function setTimedTextLanguage(url, lang) {
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.set("tlang", lang);
    return urlObj.toString();
  } catch (e) {
    console.error("Invalid URL:", url, e);
    return url;
  }
}

function shouldSkipTimedTextCollection(videoId) {
  if (document.querySelectorAll(YOUTUBE_UI_SELECTORS.videoAdsSelector)[0]?.childNodes?.length > 0) {
    return true;
  }
  if (document.querySelector(YOUTUBE_UI_SELECTORS.playPauseButtonSelector) == undefined) {
    if (getMainVideoElement()?.paused == true) {
      return true;
    }
  }
  const button = getSubtitleButtonElement();
  if (!button) {
    return true;
  }
  if (button.getAttribute("aria-pressed") == null) {
    return true;
  }
  return false;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getStorageSync(keys = null){
  return new Promise(resolve => {
    chrome.storage.sync.get(keys, resolve);
  });
}

function GetVideoId(){
  const videoIDMatched = window?.location?.href?.match(/\/watch\?v=([^&]*)/);
  if(videoIDMatched && videoIDMatched.length > 0){
    return videoIDMatched[1];
  }
  const embedIDMatched = window?.location?.href?.match(/\/embed\/([^?]*)/);
  if(embedIDMatched && embedIDMatched.length > 0){
    return embedIDMatched[1];
  }
  const liveIDMatched = window?.location?.href?.match(/\/live\/([^?]*)/);
  if(liveIDMatched && liveIDMatched.length > 0){
    return liveIDMatched[1];
  }
  return undefined;
}

// 発話を開始した事をURLで覚えておき、別のURLで起動した場合に誤動作で speechSynthesis.cancel() を呼ばないようにします。
function startSpeech(speechSynthesis, utt) {
  speakTargetUrl = location.href;
  speechSynthesis.speak(utt);
}
function stopSpeechWithSpeakCheck(speechSynthesis) {
  if(location.href != speakTargetUrl) return;
  speechSynthesis.cancel()
}

/*
ytConfig(?) から
怪しく https://www.youtube.com/youtubei/v1/player?key=...8&prettyPrint=false
にPOSTで送り込むためのデータを生成します。
*/
function GenerateYoutbeiV1PlayerPostPayload(ytConfig){
  const context = ytConfig?.INNERTUBE_CONTEXT;
  const videoId = GetVideoId();
  const payloadObj = {
    "context": context,
    "videoId": videoId
  };

  //console.log("GenerateYoutbeiV1PlayerPostPayload generate", payloadObj);
  return JSON.stringify(payloadObj);
}

// 怪しく INNERETUBE_API_KEY が書かれている辺りをHTMLから取り出して
// https://www.youtube.com/youtubei/v1/player? を叩いて
// それらしい初期データを取り出します。
async function GetYoutbeiV1PlayerData(){
  // TODO: これはかなり怪しく「ソレ」を取り出しているのでちょっとでもフォーマットが変わると誤動作するはずです。
  // 具体的には "ytcfg.set({" ではじまって ");window.ytcfg.obfscatedData_" に続く
  // までの間の物が「ソレ」だと仮定しているので、目的の ytcfg.set の直後に
  // ytcfg.obfuscatedData_ を書いていてくれないと動きません。
  // これは完全に youtube の人がどうそれを JavaScript コードに落とし込んでいるかに依存しているため、
  // 正直言って全然、全く、完膚なきまでに、よろしくありません。
  const ytCfgScript = getFirstSnapshotNode(YOUTUBE_UI_SELECTORS.configScriptXPath);
  const ytCfgJSON = ytCfgScript?.innerText?.replace(/^[\s\S]*ytcfg\.set\({/g,'{').replace(/}\);\s*window\.ytcfg\.obfuscatedData_[\s\S]*/,'}');
  if(typeof ytCfgJSON != "string" || ytCfgJSON.length <= 0){
    console.log("ERROR: ytcfg.set({\"CLIENT_CANARY_STATE... not found");
    return undefined;
  }
  try {
    const ytConfig = JSON.parse(ytCfgJSON);
    const key = ytConfig?.INNERTUBE_API_KEY;
    const payload = GenerateYoutbeiV1PlayerPostPayload(ytConfig);
    const targetUrl = `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`;
    const res = await fetch(targetUrl, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json"
      }
    });
    const resData = await res.json();
    if(!(resData?.captions?.playerCaptionsTracklistRenderer?.captionTracks)) {
      //console.log("resData has no captionTracks. now try get player_response from ytInitialPlayerResponse", resData);
      const ytInitialPlayerResponseElement = getFirstSnapshotNode(YOUTUBE_UI_SELECTORS.initialPlayerResponseXPath);
      if(!ytInitialPlayerResponseElement){
        //console.log("ytInitialPlayerResponse not found.");
        return undefined;
      }
      const ytInitialPlayerResponseCode = ytInitialPlayerResponseElement.innerText.replace("var ytInitialPlayerResponse = ","").replace(/};var .*/, '}');
      const ytInitialPlayerResponseObject = JSON.parse(ytInitialPlayerResponseCode);
      return ytInitialPlayerResponseObject;
    }
    return resData;
  }catch(err){
    console.log("GetYoutbeiV1PlayerData got error", err, ytCfgJSON);
  }
  return undefined;
}

// ytplayer.config.args.player_response の中に含まれている字幕の情報から
// 対象のロケールにおける(最適な)字幕データを取得するためのURLを生成します。
async function GetCaptionDataUrl(player_response_obj){
  // 用意されている字幕でターゲットとなるロケールの物があればそれを使います
  let captionTracks = player_response_obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if(!captionTracks){ return; }
  let playLocaleCaptionBaseUrl = captionTracks?.filter(obj => obj?.languageCode == playLocale)[0]?.baseUrl;
  if(playLocaleCaptionBaseUrl){
    return playLocaleCaptionBaseUrl + "&fmt=json3";
  }

  // なさそうなら、captionTracks の先頭の物から対象のロケールに書き換えた物を取得するようにします。
  let baseUrl = captionTracks[0]?.baseUrl;
  if(!baseUrl){ console.log("can not get baseUrl", player_response_obj); return; }
  let origUrl = baseUrl.replace(/,/g, "%2C");
  return origUrl + "&fmt=json3&xorb=2&xobt=3&xovt=3&tlang=" + playLocale;
}

var isCaptionDataFetching = false;
async function FetchCaptionData_old(captionDataUrl, isForceFetch = false){
  try {
    const url = captionDataUrl;
    if(!url){
      //isCaptionDataFetching = false;
      return undefined;
    }
    if(excludeAccessUrlList.includes(url)){
      return undefined;
    }

    let response;
    try {
      //console.log("CS: captionData fetch(1). push excludeAccessUrlList:", url);
      excludeAccessUrlList.push(url);
      response = await fetch(url);
    }catch(error) {
      //console.log(`fetch error. await fetch() failed. url: ${url}, error: ${error}`);
      //isCaptionDataFetching = false;
      return undefined;
    }
    if(response && response.ok) {
      // pass;
    }else{
      //console.log(`fetch error. response.ok: ${response?.ok} url: ${url}`, response);
      //isCaptionDataFetching = false;
      return undefined;
    }
    let json;
    try {
      json = await response.json();
    }catch(error) {
      //console.log(`json decode error: ${error}`);
      //isCaptionDataFetching = false;
      return undefined;
    }
    if(!json){isCaptionDataFetching = false;return undefined;}
    return json;
  }catch(err){
    console.log("FetchCaptionData got error:", err, window.location.href);
    //isCaptionDataFetching = false;
  }
}

function clearCaptionData(){
  captionData = {};
}

function updateCaptionFetchMetadata(playerResponse){
  const lengthSeconds = VideoLengthSecondsFromPlayerResponse(playerResponse);
  if(lengthSeconds > 0){
    videoLengthSeconds = lengthSeconds;
  }
  guessedOriginalCaptionLanguage = GuessVideoAutoTransrateOriginalLanguage(playerResponse);
}

function shouldSkipCaptionFetchByLocale(storageResult){
  return guessedOriginalCaptionLanguage == playLocale && storageResult?.isDisableSpeechIfSameLocaleVideo;
}

async function FetchCaptionDataFromPlayerResponse(){
  const playerResponse = await GetYoutbeiV1PlayerData();
  updateCaptionFetchMetadata(playerResponse);
  const url = await GetCaptionDataUrl(playerResponse);
  return FetchCaptionData_old(url);
}

async function FetchCaptionDataFromTimedText(videoId){
  const url = await getTimedTextUrl(playLocale, videoId);
  if(url === undefined) {
    return undefined;
  }
  if(excludeAccessUrlList.includes(url)){
    return undefined;
  }
  let response;
  try {
    excludeAccessUrlList.push(url);
    response = await fetch(url);
  }catch(error) {
    console.log(`CS: fetch timedText error. fetch() failed. url: ${url}, error: ${error}`);
    return undefined;
  }
  if(!(response && response.ok)) {
    console.log(`CS: fetch timedText error. response.ok is false: ${response?.ok} url: ${url}`, response);
    if(response?.text){
      const text = await response.text();
      console.log("CS: response.text():", text);
    }
    console.log("CS: accessUrlList: ", accessUrlList, "excludeAccessUrlList:", excludeAccessUrlList);
    return undefined;
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  }catch(error){
    console.log('CS: captionData JSON decode failed. text:', text, "url:", url);
    return undefined;
  }
}

function applyFetchedCaptionData(json, videoId){
  captionData = CaptionDataToTimeDict(json);
  CURRENT_VIDEO_ID = videoId;
}

function consumeContentScriptLoadDelay(){
  if(!ContentScriptLoadTime){
    return 0.0;
  }
  const now = new Date();
  const delay = (now.getTime() - ContentScriptLoadTime.getTime()) / 1000.0;
  ContentScriptLoadTime = undefined;
  return delay;
}

async function FetchCaptionData(isForceFetch = false){
  if(isCaptionDataFetching){return undefined;}
  isCaptionDataFetching = true;
  try {
    const videoId = GetVideoId();
    if(videoId == CURRENT_VIDEO_ID && !isForceFetch){return undefined;}
    let json = undefined;
    const storageResult = await getStorageSync(CAPTION_FETCH_STORAGE_KEYS);
    if(!isSpeechEnabled(storageResult)) {
      return undefined;
    }
    try {
      json = await FetchCaptionDataFromPlayerResponse();
      if(shouldSkipCaptionFetchByLocale(storageResult)){
        clearCaptionData();
        return undefined;
      }
    }catch(err){
      console.log("CS: FetchCaptionData phase 1 captionData JSON read failed. catch error:", err);
    }
    console.log("FetchCaptionData first try json:", json);
    console.log("CS: accessUrlList: ", accessUrlList, "excludeAccessUrlList:", excludeAccessUrlList);
    if (json === undefined) {
      json = await FetchCaptionDataFromTimedText(videoId);
      if(json === undefined) {
        clearCaptionData();
        return undefined;
      }
    }
    applyFetchedCaptionData(json, videoId);
    if (storageResult?.isSpeechWithoutSyncEnabled) {
      SpeechAllWithoutSync();
      return undefined;
    }
    const loadDelay = consumeContentScriptLoadDelay();
    if(loadDelay > 0){
      CheckVideoCurrentTime(loadDelay);
    }
    return undefined;
  } finally {
    isCaptionDataFetching = false;
  }
}

function FormatTimeFromMillisecond(millisecond){
  let totalSecond = millisecond / 1000;
  let hour = parseInt((totalSecond / 60 / 60) % 24);
  var minute = parseInt((totalSecond / 60) % 60);
  var second = parseInt((totalSecond) % 60);
  if(second < 10){ second = "0" + second; }
  if(hour > 0 && minute < 10){ minute = "0" + minute; }
  if(hour > 0){
    return hour + ":" + minute + ":" + second;
  }
  return minute + ":" + second;
}

function CheckCaptionIsDisplaying(){
  return getSubtitleButtonElement()?.getAttribute('aria-pressed') == "true";
}

// player_response から .microformat.playerMicroformatRenderer.lengthSeconds を取り出します
function VideoLengthSecondsFromPlayerResponse(player_response){
  return player_response?.videoDetails?.lengthSeconds;
}

function GuessVideoAutoTransrateOriginalLanguage(player_response){
  let captionTracks = player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let autoDetectedCaption = captionTracks?.filter(x=> x["kind"] == "asr");
  if(autoDetectedCaption){
    return autoDetectedCaption[0]?.languageCode;
  }
  if(captionTracks){
    return captionTracks[0]?.languageCode;
  }
  return undefined;
}

// 字幕のデータを後で使いやすいように加工しておきます。
function CaptionDataToTimeDict(captionData){
  let events = captionData?.events;
  if(!events){ console.log("CaptionDataToTimeDict(): error. events not found"); return; }
  let captionArray = events.map((obj)=>{
    let tStartMs = obj?.tStartMs;
    // 表示上は分割して表示されるのですが、最低1文字づつで分割されており
    // そのまま読み上げるとぶつ切りで聞くに堪えない事になるため、
    // セグメント(表示上は一行分になるもの)についてはひとかたまりに加工しておきます。
    let segment = obj?.segs?.reduce((acc,current)=>{
      let text = current?.utf8.replace(/<\s*\/?(b|i|u|tt|big|small|sub|sup|em|strong|samp|code|kbd|var|cite)\s*>/ig, "");
      if(text){
        return acc + text;
      }
      return acc;
    }, '');
    return {"tStartMs": tStartMs, "segment": segment, "time": FormatTimeFromMillisecond(tStartMs)};
  }).filter((obj)=>{
    // 発話という意味では中身が空の物は意味がないのでここで消しておきます
    let segment = obj?.segment;
    if(segment?.length > 0 && segment.replace(/[\s\r\n]*/g, "").length > 0){
      return true;
    }
    return false;
  });
  var timeDict = {};
  captionArray.map(obj=>timeDict[obj.time]=obj);
  return timeDict;
}

function UpdatePlayLocale(locale){
  let l = locale?.replace(/-.*$/, '');
  if(l?.length > 0 && playLocale != l){
    playLocale = l;
    // locale が変わっていたなら、今読み込まれている字幕データは破棄して新しく読み直さないと謎の発話を続ける事になります。
    captionData = {};
    FetchCaptionData(true);
  }
}

function findSelectedVoice(voiceList, lang, voiceName){
  for(const voice of voiceList){
    if(voice.lang == lang && voice.name == voiceName){
      return voice;
    }
  }
  return undefined;
}

function getVoiceParameter(value, fallback){
  return value ? value : fallback;
}

function StorageResultToVoiceSettings(result){
  let lang = result.lang;
  let voiceName = result.voice;
  let voiceList = speechSynthesis.getVoices();
  const voiceVoice = findSelectedVoice(voiceList, lang, voiceName);
  if(voiceVoice){
    UpdatePlayLocale(lang);
  }
  return {
    voicePitch: getVoiceParameter(result.pitch, 1.0),
    voiceRate: getVoiceParameter(result.rate, 1.6),
    voiceVolume: getVoiceParameter(result.volume, 1.0),
    voiceVoice: voiceVoice,
    isStopIfNewSpeech: result?.isStopIfNewSpeech ? true : false,
  };
}

// video側 ではなく HTML側 からボリューム設定を読み取ります。
// ただ、このDOMは読み出し損なう場合があるようなので、fallbackVolumeを受け取って、
// 読み出せなかった場合はその値を返します。
// 返却される値は 0 から 1  までの値であることを期待して良いです。
function GetYtpVolumePanelValue(fallbackVolume){
  const ytpVolumePanelCurrentValue = getFirstSnapshotNode(YOUTUBE_UI_SELECTORS.volumeXPath)?.value;
  if(ytpVolumePanelCurrentValue){
    return Math.min(1, Math.max(0, ytpVolumePanelCurrentValue / 100.0));
  }
  return fallbackVolume;
}

// 読み上げ開始時と終了時に元動画側のボリュームを弄るための関数。
// 読み上げ開始と終了は前後する場合があるので、
// 読み上げ開始時に+1, 終了時に -1 する値を作っておいて、
// 0 以下になった時だけ元の音量に戻すようにします。
// 具体的には、「新しく発話する時に前の発話を止める」オプションがONになっていて
// 前の発話を止めてから新しく発話しようとした場合に、
// 前の発話が止まった時の停止イベントよりも、
// 新しく発話しようとして発話queueに詰める時の方が先に発生する、という事象が発生します。
var overrideVolumeCount = 0;
function volumeOverride(videoElement, originalVolume, targetVolumeMagnification){
  overrideVolumeCount += 1;
  videoElement.volume = Math.min(Math.max(0, originalVolume * targetVolumeMagnification), 1);
}
function volumeRecover(videoElement, originalVolume){
  overrideVolumeCount -= 1;
  if(overrideVolumeCount <= 0){
    videoElement.volume = originalVolume;
  }
}

function normalizeSpeechText(text){
  return text.replace(/(\n)/g, () => " ");
}

function applyVoiceSettingsToUtterance(utterance, setting){
  if(setting.voiceVoice){
    utterance.voice = setting.voiceVoice;
    utterance.lang = utterance.voice.lang;
  }
  utterance.pitch = setting.voicePitch;
  utterance.rate = setting.voiceRate;
  utterance.volume = setting.voiceVolume;
}

function attachVolumeRecoveryHandlers(utterance, storageResult, videoElement){
  if(!(storageResult.isOverrideOriginalVolumeEnabled && originalVolume && videoElement)){
    return;
  }
  const targetVolume = GetYtpVolumePanelValue(originalVolume);
  volumeOverride(videoElement, targetVolume, storageResult.overrideOriginalVolumeMagnification);
  const recoverFunc = () => {
    const targetVolume = GetYtpVolumePanelValue(originalVolume);
    volumeRecover(videoElement, targetVolume);
  };
  utterance.onend = recoverFunc;
  utterance.onerror = recoverFunc;
  utterance.onpause = recoverFunc;
}

function resumeSpeechIfMoviePlayerActive(){
  const screen = getMoviePlayerElement();
  if (screen?.classList.contains("playing-mode")) {
    paused = false;
    speechSynthesis.resume();
  }
}

function buildCaptionSpeechText(captionData){
  return Object.values(captionData).reduce((acc, caption) => acc + " " + caption.segment, "");
}

function AddSpeechQueue(text, storageResult, videoElement){
  var textVoice = normalizeSpeechText(text);
  // console.log(textVoice)
//console.log("CS: AddSpeechQueue", textVoice, videoElement, storageResult);
  const utt = new SpeechSynthesisUtterance(textVoice);
  const setting = StorageResultToVoiceSettings(storageResult);
  applyVoiceSettingsToUtterance(utt, setting);
  utt.onerror = function(event){
    if(event.error == "interrupted") return;
    console.log("SpeechSynthesisUtterance Event onError", event);
  };
  attachVolumeRecoveryHandlers(utt, storageResult, videoElement);
  if(setting.isStopIfNewSpeech){
    stopSpeechWithSpeakCheck(speechSynthesis);
  }

  // prevents from no speaking when switching tabs
  // it seems better to also check if speechSynthesis.paused, but for some reasons it returns false even when it's paused
  resumeSpeechIfMoviePlayerActive();
  startSpeech(speechSynthesis, utt);
}

// 単純に秒単位で時間を確認して、前回読み上げた時間と変わっているのなら発話する、という事をします。
function CheckAndSpeech(currentTimeText, storageResult, videoElement){
  if(captionData === undefined){return;}
  if(!currentTimeText){ console.log("currentTimeText is nil"); return;}
  if(currentTimeText == prevSpeakTime){ return;}
  if(storageResult.isDisableSpeechIfChaptionDisabled && !CheckCaptionIsDisplaying()){ return; }
  let caption = captionData[currentTimeText];
  if(caption){
    prevSpeakTime = currentTimeText;
    AddSpeechQueue(caption.segment, storageResult, videoElement);
    return;
  }
  //console.log("no caption:", currentTimeText);
}

function IsValidVideoDuration(duration, captionData){
  if(videoLengthSeconds > 0){
    return Math.abs(videoLengthSeconds - duration) < 4;
  }
  var maxMillisecond = 0;
  for(let key in captionData){
    let tStartMs = captionData[key]?.tStartMs;
    if(tStartMs > maxMillisecond){
      maxMillisecond = tStartMs;
    }
  }
  return duration >= maxMillisecond / 1000;
}

function IsTargetUrlWithOption(url, storageResult){
  if(storageResult.isDisableSpeechEmbeddedSite){
    return url.indexOf("https://www.youtube.com/watch?") == 0 || url.indexOf("https://www.youtube.com/live/") == 0;
  }
  return url.indexOf("https://www.youtube.com/watch?") == 0 || url.indexOf("https://www.youtube.com/live/") == 0 || url.indexOf("https://www.youtube.com/embed/") == 0;
}

async function IsTargetUrl(){
  const url = location.href;
  const storageResult = await getStorageSync(["isDisableSpeechEmbeddedSite"]);
  return IsTargetUrlWithOption(url, storageResult);
}

async function SpeechAllWithoutSync() {
  const storageResult = await getStorageSync(VIDEO_TIME_CHECK_STORAGE_KEYS);
  if(!IsTargetUrlWithOption(location.href, storageResult)){return;}
  if(!isSpeechEnabled(storageResult)){return;}
  let videoElement = getMainVideoElement();
  if(!videoElement){
    console.log("CheckVideoCurrentTime videoElement is not found:", videoElement);
    return;
  }
  if(typeof(originalVolume) == "undefined"){
    originalVolume = videoElement.volume;
  }
  let currentTime = videoElement.currentTime;
  let duration = videoElement.duration;
  if(isNaN(duration)){return;}
  if(!IsValidVideoDuration(duration, captionData)){
    console.log("CheckVideoCurrentTime is not valid VideoDuration. currentTime:", currentTime, "duration:", duration, "captionData:", captionData);
    //UpdateCaptionData();
    return;
  }
  const textVoice = buildCaptionSpeechText(captionData);
  stopSpeechWithSpeakCheck(speechSynthesis);
  AddSpeechQueue(textVoice, storageResult, videoElement);
}

function ensureOriginalVolume(videoElement){
  if(typeof(originalVolume) == "undefined"){
    originalVolume = videoElement.volume;
  }
}

function getVideoPlaybackState(videoElement){
  const currentTime = videoElement.currentTime;
  const duration = videoElement.duration;
  return {
    currentTime,
    duration,
    isDurationKnown: !isNaN(duration)
  };
}

function buildTimeTextsToCheck(currentTime, loadGapSecond){
  const timeTexts = [];
  for(let gap = loadGapSecond; gap >= 0; gap -= 1){
    timeTexts.push(FormatTimeFromMillisecond((currentTime - gap) * 1000));
  }
  return timeTexts;
}

function shouldCheckCurrentVideo(storageResult){
  if(!IsTargetUrlWithOption(location.href, storageResult)){return false;}
  if(!isSpeechEnabled(storageResult)){return false;}
  if(storageResult.isSpeechWithoutSyncEnabled){return false;}
  return true;
}

function checkCurrentVideoTimeTexts(currentTime, loadGapSecond, storageResult, videoElement){
  const timeTexts = buildTimeTextsToCheck(currentTime, loadGapSecond);
  for(const timeText of timeTexts){
    if(prevCheckVideoTimeText == timeText){return;}
    prevCheckVideoTimeText = timeText;
    CheckAndSpeech(timeText, storageResult, videoElement);
  }
}

// 再生位置を video object の .currentTime から取得して、発話が必要そうなら発話させます
async function CheckVideoCurrentTime(loadGapSecond = 0.0){
  const storageResult = await getStorageSync(VIDEO_TIME_CHECK_STORAGE_KEYS);
  if(!shouldCheckCurrentVideo(storageResult)){return;}
  let videoElement = getMainVideoElement();
  if(!videoElement){
    console.log("CheckVideoCurrentTime videoElement is not found:", videoElement);
    return;
  }
  ensureOriginalVolume(videoElement);
  const playbackState = getVideoPlaybackState(videoElement);
  if(!playbackState.isDurationKnown){return;}
  const { currentTime, duration } = playbackState;
  if(!IsValidVideoDuration(duration, captionData)){
    UpdateCaptionData();
    return;
  }
  checkCurrentVideoTimeTexts(currentTime, loadGapSecond, storageResult, videoElement);
}

// "https://www.youtube.com/api/timedtext" で始まるURLがリクエストされた場合に貯めておきます。
// これの、tlang=ja  の部分を書き換えることで自動翻訳のものが取り出せる事になります。
var accessUrlList = []; // アクセスされた timedtext のURLリスト
var excludeAccessUrlList = []; // 以前の timedtext URL 生成で取得されるものについては保存しないようにするためこれを覚えておきます。
function onUrlAccessed(url) {
  if(url.includes('https://www.youtube.com/api/timedtext') && (!excludeAccessUrlList.includes(url))){
    accessUrlList.push(url);
  }
}

async function doubleClickWithDelay(buttonElement) {
  if (!buttonElement) {
    return;
  }

  let initialAriaPressed = buttonElement.getAttribute('aria-pressed');

  // 必ず2回はクリックしてなにがなんでも字幕を読み取ってもらいます
  buttonElement.click();
  await sleep(200);
  buttonElement.click();
  await sleep(200);
  var ariaPressed = buttonElement.getAttribute('aria-pressed');
  while(ariaPressed == null || ariaPressed == 'true'){
    if(ariaPressed != null){
      buttonElement.click();
    }
    await sleep(200);
    ariaPressed = buttonElement.getAttribute('aria-pressed');
  }
  if(ariaPressed != initialAriaPressed) {
    buttonElement.click();
  }
  await sleep(100);
}

let getTimedTextUrl_checkedVideoId = undefined;
async function getTimedTextUrl(lang, videoId) {
  let filteredAccessUrlList = filterTimedTextAccessUrls(accessUrlList, videoId);
  if(filteredAccessUrlList.length <= 0) {
    if(shouldSkipTimedTextCollection(videoId)) {
      return undefined;
    }
    const button = getSubtitleButtonElement();

    if(getTimedTextUrl_checkedVideoId !== videoId) {
      await doubleClickWithDelay(button);
      getTimedTextUrl_checkedVideoId = videoId;
    }
    for(var i = 0; i < 10; i++){
      filteredAccessUrlList = filterTimedTextAccessUrls(accessUrlList, videoId);
      if(filteredAccessUrlList.length > 0){
        break;
      }
      await sleep(100);
    }
    if(filteredAccessUrlList.length <= 0){
      console.log("CS: getTimedTextUrl() failed.", "filteredAccessUrlList:", filteredAccessUrlList, "excludeAccessUrlList", excludeAccessUrlList, "accessUrlList", accessUrlList);
      return undefined;
    }
  }
  // 現在 filteredAccessUrlList に保存されているURLのうち、最後の URL を取り出します。
  let url = findLatestTimedTextUrl(filteredAccessUrlList, excludeAccessUrlList, videoId);
  if(url === undefined) {
    console.log("CS: getTimedTextUrl return undefined. url not found.", "filteredAccessUrlList:", filteredAccessUrlList, "excludeAccessUrlList", excludeAccessUrlList, "accessUrlList", accessUrlList);
    return undefined;
  }
  return setTimedTextLanguage(url, lang);
}

function UpdateCaptionData(){
  FetchCaptionData();
}

async function LoadBooleanSettings(){
  const storageResult = await getStorageSync(["isEnabled"]);
  const isEnabled = storageResult?.isEnabled || typeof storageResult?.isEnabled == "undefined";
  if(!isEnabled){
    stopSpeechWithSpeakCheck(speechSynthesis);
  }
}
chrome.runtime.onMessage.addListener(
  function(message, sender, sendResponse){
    //console.log("onMessage", message, sender, sendResponse);
    switch(message.type){
    case "SettingsUpdated":
      LoadBooleanSettings();
      UpdateCaptionData();
      break;
    case "LoadBooleanSettings":
      LoadBooleanSettings();
      break;
    case "url_accessed":
      onUrlAccessed(message.url);
      break;
    default:
      break;
    }
  }
);

var ToplevelObserver = undefined;
var VideoTimeCheckTimerID = undefined;

function StartVideoTimeChecker(){
  if(CURRENT_VIDEO_ID == GetVideoId()){
    CheckVideoCurrentTime().catch((e)=>{
      console.log("CheckVideoCurrentTime got error. video time checker stop:", e);
      StopVideoTimeChecker();
    });
  }
  VideoTimeCheckTimerID = setTimeout(StartVideoTimeChecker, 250);
}
function StopVideoTimeChecker(){
  if(VideoTimeCheckTimerID){
    clearTimeout(VideoTimeCheckTimerID);
    VideoTimeCheckTimerID = undefined;
  }
}

async function CheckPlayLocaleUpdate(){
  const storageResult = await getStorageSync(["lang", "voice"]);
  let lang = storageResult.lang;
  let voiceName = storageResult.voice;
  let voiceList = speechSynthesis.getVoices();
  for(voice of voiceList){
    if(voice.lang == lang && voice.name == voiceName){
      let l = lang?.replace(/-.*$/, '');
      if(l?.length > 0 && playLocale != l){
        playLocale = l;
      }
      return;
    }
  }
}

// https://www.youtube.com/ の時に仕掛ける mutation observer.
// Youtube は /channel/ から動画をクリックして /watch?v=... に遷移した時に
// URLを移動したという感じのイベントが発生しないぽくて、
// ChromeExtension で "https://www.youtube.com/watch?" を対象にした
// contentScript が発火しないため、
// "https://www.youtube.com/" の場合に document.body に対して mutation observer を仕掛け、
// その document.body の childList を見張ってページ書き換えを検知するようにします。
async function KickToplevelObserver(){
  if(ToplevelObserver){
    ToplevelObserver.disconnect();
    ToplevelObserver = undefined;
  }
  const storageResult = await getStorageSync(["isSpeechWithoutSyncEnabled"]);
  ToplevelObserver = new MutationObserver((mutationList, observer) => {
    //console.log("MutationObserver mutate event got (document.body):", mutationList, observer, window.location.href);
    const videoId = GetVideoId();
    IsTargetUrl().then((isTargetUrl)=>{
      if(isTargetUrl){
        if(videoId == CURRENT_VIDEO_ID){return;}
        // UpdateCaptionData は /watch?v=... の ... が変わった時だけで良いはず
        ContentScriptLoadTime = new Date(); // ページが変わったぽいので load time を解消しておきます
        UpdateCaptionData();
        if (!storageResult.isSpeechWithoutSyncEnabled) {
          StartVideoTimeChecker();
        }
      }else{
        StopVideoTimeChecker();
      }
    }).catch(e => {
      console.log("ToplevelObserver: IsTargetUrl got error", e);
    });
  });
  const toplevel = document.body;
  ToplevelObserver.observe(toplevel, {
    childList: true,
    subtree: true,
  });
}

// www.youtube.com の時は toplevelobserver を仕掛けておかないと、画面遷移時に開始できない事があります。
if(location.href.indexOf("https://www.youtube.com/") == 0){
  (async ()=>{
    await CheckPlayLocaleUpdate();
    KickToplevelObserver();
  })();
}

chrome.storage.onChanged.addListener((changes, namespace)=>{
  for(const [key, {oldValue, newValue}] of Object.entries(changes)){
    switch(key){
      case "isDisableSpeechIfSameLocaleVideo":
        FetchCaptionData(true);
        return;
      case "isDisableSpeechEmbeddedSite":
        if(location.href.indexOf("https://www.youtube.com/embed/") == 0 && !newValue){
          StartVideoTimeChecker();
        }
        break;
      case "isSpeechWithoutSyncEnabled":
        if (newValue) {
          StopVideoTimeChecker();
          SpeechAllWithoutSync();
        } else {
          stopSpeechWithSpeakCheck(speechSynthesis);
          StartVideoTimeChecker();
        }
        break;
      case "lang":
        //console.log("lang changed. update play locale...");
        UpdatePlayLocale(newValue);
        return;
      default:
        break;
    }
  }
});

function InitializeScreenObserver(){
  const screen = getMoviePlayerElement();

  // if screen is not on the page - return
  if (!screen){
    return;
  }

  // prevents from speaking a remaining part of a speech when opening a new YouTube tab
  stopSpeechWithSpeakCheck(speechSynthesis);

  // configuration of the screen observer
  const config = { attributes: true, subtree: true, attributeFilter: ['class', 'src']};

  screenObserver.observe(screen, config);

  // prevents from speaking a remaining part of a speech when changing tabs
  window.addEventListener("blur", function(event) {
    if (paused) stopSpeechWithSpeakCheck(speechSynthesis);
  });
}

let paused = false;
let pauseTime;

// movie_player observer to react on pause
const screenObserver = new MutationObserver(function (mutations) {
  mutations.forEach(function (mutation) {

    // cancels speechSynthesis if url was changed
    if (mutation.attributeName === "src"){
      stopSpeechWithSpeakCheck(speechSynthesis);
      return;
    }

    if (mutation.target.classList.contains("paused-mode")) {
      if (paused) {
        return;
      }
      paused = true;
      if(speechSynthesis.speaking) {
        speechSynthesis.pause();
      }
      pauseTime = mutation.target.querySelector(YOUTUBE_UI_SELECTORS.videoStreamSelector).currentTime;
    }
    if (mutation.target.classList.contains("playing-mode")) {
      if (!paused) {
        return;
      }
      paused = false;
      // resumes if the time before and after the pause differs by less than 1 sec, or if undefined (videoElement is not found)
      if (Math.abs(mutation.target.querySelector(YOUTUBE_UI_SELECTORS.videoStreamSelector).currentTime - pauseTime) > 1){
        stopSpeechWithSpeakCheck(speechSynthesis);
      }
      else {
        speechSynthesis.resume();
      }
    }
  });
});

InitializeScreenObserver();
