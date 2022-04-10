let speechSynthesis = window.speechSynthesis;
let TARGET_ID = "CaptionSpeakerData";
let PLAYER_RESPONSE_ATTRIBUTE_NAME = "ytplayer.config.args.raw_player_response";
var prevSpeakTime = "";
var playLocale = window.navigator.language;
var captionData = {};
var isEnabled = false;
var isStopIfNewSpeech = false;
var isDisableSpeechIfSameLocaleVideo = false;
var isDisableSpeechIfChaptionDisabled = false;
var videoLengthSeconds = -1;
var guessedOriginalCaptionLanguage = undefined;

var voicePitch = 1.0;
var voiceRate = 1.6;
var voiceVolume = 1.0;
var voiceVoice = undefined;

function GetVideoId(){
  const videoIDMatched = window?.location?.href?.match(/\/watch\?v=(.*)/);
  if(videoIDMatched && videoIDMatched.length > 0){
    return videoIDMatched[1];
  }
  const embedIDMatched = window?.location?.href?.match(/\/embed\/(.*)/);
  if(embedIDMatched && embedIDMatched.length > 0){
    return embedIDMatched[1];
  }
  return undefined;
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
  const ytCfgJSON = document.evaluate("//script[@nonce and contains(text(),'INNERTUBE_API_KEY')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0).innerText.replace(/^[\s\S]*ytcfg\.set\({/g,'{').replace(/}\);\s*window\.ytcfg\.obfuscatedData_[\s\S]*/,'}');
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
    return resData;
  }catch(err){
    console.log("GetYoutbeiV1PlayerData got error", err, ytCfgJSON);
  }
  return undefined;
}

// ytplayer.config.args.player_response の中に含まれている字幕の情報から
// 対象のロケールにおける(最適な)字幕データを取得するためのURLを生成します。
async function GetCaptionDataUrl(){
  const player_response_obj = await GetYoutbeiV1PlayerData();
  // GetCaptionDataUrl() という関数なのに、ここでは怪しく player_response を読み込んでいます。('A`)
  let lengthSeconds = VideoLengthSecondsFromPlayerResponse(player_response_obj);
  if(lengthSeconds > 0){ videoLengthSeconds = lengthSeconds; }
  guessedOriginalCaptionLanguage = GuessVideoAutoTransrateOriginalLanguage(player_response_obj);
  //console.log("guessedOriginalCaptionLanguage", guessedOriginalCaptionLanguage);

  // 用意されている字幕でターゲットとなるロケールの物があればそれを使います
  let captionTracks = player_response_obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let playLocaleCaptionBaseUrl = captionTracks?.filter(obj => obj?.languageCode == playLocale)[0]?.baseUrl;
  if(playLocaleCaptionBaseUrl){
    return playLocaleCaptionBaseUrl + "&fmt=json3";
  }

  // なさそうなら、captionTracks の先頭の物から対象のロケールに書き換えた物を取得するようにします。
  if(!captionTracks){ console.log("can not get captionTracks", player_response_obj); return; }
  let baseUrl = captionTracks[0]?.baseUrl;
  if(!baseUrl){ console.log("can not get baseUrl", player_response_obj); return; }
  let origUrl = baseUrl.replace(/,/g, "%2C");
  return origUrl + "&fmt=json3&xorb=2&xobt=3&xovt=3&tlang=" + playLocale;
}

var CURRENT_VIDEO_ID = "invalid video id!";
async function FetchCaptionData(){
  try {
    const videoId = GetVideoId();
    if(videoId == CURRENT_VIDEO_ID){return undefined;}
    CURRENT_VIDEO_ID = videoId;
    const url = await GetCaptionDataUrl();
    if(!url){return undefined;}
    const response = await fetch(url);
    if(!response){return undefined;}
    const json = await response.json();
    if(!json){return undefined;}
    if(guessedOriginalCaptionLanguage == playLocale && isDisableSpeechIfSameLocaleVideo){return undefined;}
    captionData = CaptionDataToTimeDict(json);
    //console.log("captionData updated", captionData);
  }catch(err){
    console.log("FetchCaptionData got error:", err, window.location.href);
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
  return document.evaluate("//button[contains(@class,'ytp-subtitles-button')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0)?.getAttribute('aria-pressed') == "true";
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
      let text = current?.utf8;
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
    UpdateCaptionData();
  }
}

function LoadVoiceSettings(){
  chrome.storage.sync.get(["lang", "voice", "pitch", "rate", "volume"], (result)=>{
    let lang = result.lang;
    let voiceName = result.voice;
    let voiceList = speechSynthesis.getVoices();
    for(voice of voiceList){
      if(voice.lang == lang && voice.name == voiceName){
        voiceVoice = voice;
        UpdatePlayLocale(lang);
      }
    }
    let pitch = result.pitch;
    if(pitch){
      voicePitch = pitch;
    }
    let rate = result.rate;
    if(rate){
      voiceRate = rate;
    }
    let volume = result.volume;
    if(volume){
      voiceVolume = volume;
    }
  });
}

function AddSpeechQueue(text){
  let utt = new SpeechSynthesisUtterance(text);
  if(voiceVoice){
    utt.voice = voiceVoice;
    utt.lang = utt.voice.lang;
  }
  utt.pitch = voicePitch;
  utt.rate = voiceRate;
  utt.volume = voiceVolume;
  utt.onerror = function(event){console.log("SpeechSynthesisUtterance Event onError", event);};
  if(isStopIfNewSpeech){
    //console.log("isStopIfNewSpeech is true");
    speechSynthesis.cancel();
  }
  speechSynthesis.speak(utt);
}

// 単純に秒単位で時間を確認して、前回読み上げた時間と変わっているのなら発話する、という事をします。
function CheckAndSpeech(currentTimeText){
  if(!currentTimeText){ console.log("currentTimeText is nil"); return;}
  if(currentTimeText == prevSpeakTime){ return;}
  if(isDisableSpeechIfChaptionDisabled && !CheckCaptionIsDisplaying()){ return; }
  let caption = captionData[currentTimeText];
  if(caption){
    prevSpeakTime = currentTimeText;
    AddSpeechQueue(caption.segment);
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

function IsTargetUrl(){
  const url = location.href;
  return url.indexOf("https://www.youtube.com/watch?") == 0 || url.indexOf("https://www.youtube.com/embed/") == 0;
}

var prevCheckVideoTimeText = "";
// 再生位置を video object の .currentTime から取得します
function CheckVideoCurrentTime(){
  //console.log("CaptionSpeaker checking location", location.href);
  if(!IsTargetUrl()){return;}
  if(!isEnabled){return;}
  let videoElement = document.evaluate("//video[contains(@class,'html5-main-video')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)?.snapshotItem(0);
  if(!videoElement){
    console.log("CheckVideoCurrentTime videoElement is not found:", videoElement);
    return;
  }
  let currentTime = videoElement.currentTime;
  let duration = videoElement.duration;
  if(isNaN(duration)){return;}
  if(!IsValidVideoDuration(duration, captionData)){
    console.log("CheckVideoCurrentTime is not valid VideoDuration. currentTime:", currentTime, "duration:", duration, "captionData:", captionData);
    return;
  }
  let timeText = FormatTimeFromMillisecond(currentTime * 1000);
  if(prevCheckVideoTimeText == timeText){return;}
  prevCheckVideoTimeText = timeText;
  CheckAndSpeech(timeText);
}

function UpdateCaptionData(){
  FetchCaptionData();
}

function LoadBooleanSettings(){
  chrome.storage.sync.get(["isEnabled", "isStopIfNewSpeech", "isDisableSpeechIfSameLocaleVideo", "isDisableSpeechIfChaptionDisabled"], (result)=>{
    if(result?.isEnabled){
      isEnabled = true;
    }else{
      isEnabled = false;
      speechSynthesis.cancel();
    }
    if(result?.isStopIfNewSpeech){
      isStopIfNewSpeech = true;
    }else{
      isStopIfNewSpeech = false;
    }
    if(result?.isDisableSpeechIfSameLocaleVideo){
      isDisableSpeechIfSameLocaleVideo = true;
    }else{
      isDisableSpeechIfSameLocaleVideo = false;
    }
    if(result?.isDisableSpeechIfChaptionDisabled){
      isDisableSpeechIfChaptionDisabled = true;
    }else{
      isDisableSpeechIfChaptionDisabled = false;
    }
  });
}
function UpdateIsEnabled(isEnabled){
  chrome.storage.sync.set({"isEnabled": isEnabled});
}

chrome.runtime.onMessage.addListener(
  function(message, sender, sendResponse){
    //console.log("onMessage", message, sender, sendResponse);
    switch(message.type){
    case "KickSpeech":
      isEnabled = true;
      UpdateIsEnabled(isEnabled);
      LoadVoiceSettings();
      UpdateCaptionData();
      break;
    case "StopSpeech":
      isEnabled = false;
      UpdateIsEnabled(isEnabled);
      speechSynthesis.cancel();
      break;
    case "SettingsUpdated":
      LoadBooleanSettings();
      LoadVoiceSettings();
      UpdateCaptionData();
      break;
    case "LoadBooleanSettings":
      LoadBooleanSettings();
      break;
    default:
      break;
    }
  }
);

var ToplevelObserver = undefined;
var VideoTimeCheckTimerID = undefined;

function StartVideoTimeChecker(){
  CheckVideoCurrentTime();
  setTimeout(StartVideoTimeChecker, 250);
}
function StopVideoTimeChecker(){
  if(VideoTimeCheckTimerID){
    clearTimeout(VideoTimeCheckTimerID);
    VideoTimeCheckTimerID = undefined;
  }
}

// https://www.youtube.com/ の時に仕掛ける mutation observer.
// Youtube は /channel/ から動画をクリックして /watch?v=... に遷移した時に
// URLを移動したという感じのイベントが発生しないぽくて、
// ChromeExtension で "https://www.youtube.com/watch?" を対象にした
// contentScript が発火しないため、
// "https://www.youtube.com/" の場合に document.body に対して mutation observer を仕掛け、
// その document.body の childList を見張ってページ書き換えを検知するようにします。
function StartToplevelObserver(){
  if(ToplevelObserver){
    ToplevelObserver.disconnect();
    ToplevelObserver = undefined;
  }
  ToplevelObserver = new MutationObserver((mutationList, observer) => {
    //console.log("MutationObserver mutate event got (document.body):", mutationList, observer, window.location.href);
    if(IsTargetUrl()){
      // UpdateCaptionData は /watch?v=... の ... が変わった時だけで良いはず
      UpdateCaptionData();
      StartVideoTimeChecker();
    }else{
      StopVideoTimeChecker();
    }
  });
  const toplevel = document.body;
  ToplevelObserver.observe(toplevel, {
    childList: true,
    subtree: false
  });
}

function StartDomChangeWatcher(){
  StartToplevelObserver();
}

// とりあえず Youtube のURLにだけ反応するようにします。
// これをやっておかないと "<all_urls>" を対象にしている時に
// 必要の無いURLでも動き始めてしまう事になります。
if(location.href.indexOf("https://www.youtube.com/") == 0){
  LoadBooleanSettings();
  LoadVoiceSettings();
  //UpdateCaptionData(); // ← 最初の一発目は watcher が走らせてくれるはずなので、この時点では必要ないため、コメントアウトしておきます
  StartDomChangeWatcher();
  window.addEventListener('popstate',(ev) =>{
    console.log("popstate?", ev, location.href);
  });
}

