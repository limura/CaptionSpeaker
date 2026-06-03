let speechSynthesis = window.speechSynthesis;

// コンテンツスクリプト全体で共有する可変状態をひとつにまとめたもの。
// 以前はトップレベルに散らばった var/let だったが、見通しのため state に集約した。
// (テストからは module.exports 経由で state を直接書き換えて検証する)
const state = {
  prevSpeakTime: "",                         // 直近に発話した時刻テキスト("m:ss")。重複発話の抑止に使う
  playLocale: window.navigator.language,     // 読み上げ対象の言語(地域サフィックスを除いたもの)
  captionData: {},                           // 現在の動画の字幕辞書 { "m:ss": {tStartMs, segment, time} }
  videoLengthSeconds: -1,                    // player_response 由来の動画長(秒)。不明なら -1
  guessedOriginalCaptionLanguage: undefined, // 自動翻訳元と推定した言語コード
  currentVideoId: "invalid video id!",       // 字幕を読み込み済みの動画ID
  prevCheckVideoTimeText: "",                // 直近にチェックした再生位置テキスト("m:ss")
  originalVolume: undefined,                 // 元動画の音量(読み上げ中に下げて元に戻すため)
  contentScriptLoadTime: new Date(),         // スクリプト読み込み時刻。初回の遅延補正に使う
  speakTargetUrl: undefined,                 // 発話を開始したURL。別URLからの cancel 誤爆を防ぐ
  isCaptionDataFetching: false,              // 字幕取得が進行中かどうか(多重取得の抑止)
  overrideVolumeCount: 0,                    // 音量上書きの参照カウント(開始+1/終了-1)
  accessUrlList: [],                         // 観測した timedtext のURLリスト
  excludeAccessUrlList: [],                  // 取得済みで再取得しない timedtext URL
  lastSubtitleClickVideoId: undefined,       // timedtext 収集で字幕ボタンを押した動画ID
  paused: false,                             // プレイヤーが一時停止中かどうか
  pauseTime: undefined,                      // 一時停止した時点の再生位置(秒)
};

// デバッグ用ログ。既定では無効。(F-5)
// 既定で console に視聴URLや字幕内容を出力すると情報露出になり得るため、
// 通常は出力しない。問題調査時は CS_DEBUG を true にすると詳細が出力される。
const CS_DEBUG = false;
function debugLog(){
  if(CS_DEBUG){ console.log.apply(console, arguments); }
}

const YOUTUBE_UI_SELECTORS = {
  initialPlayerResponseXPath: "//script[@nonce and contains(text(),'var ytInitialPlayerResponse')]",
  subtitlesButtonXPath: "//button[contains(@class,'ytp-subtitles-button')]|//button[@class='ytmClosedCaptioningButtonButton']",
  videoXPath: "//video[contains(@class,'html5-main-video')]",
  volumeXPath: "//span[@class='ytp-volume-area']/div[@aria-valuenow]/@aria-valuenow",
  moviePlayerSelector: "#movie_player[class*='html5-video-player']",
  playPauseButtonSelector: "button.player-control-play-pause-icon",
  videoAdsSelector: "#ytd-player .video-ads",
  videoStreamSelector: ".video-stream"
};

// 読み上げ対象となる YouTube ページのURL接頭辞。
const YOUTUBE_ORIGIN_PREFIX = "https://www.youtube.com/";
const WATCH_URL_PREFIX = "https://www.youtube.com/watch?";
const LIVE_URL_PREFIX = "https://www.youtube.com/live/";
const EMBED_URL_PREFIX = "https://www.youtube.com/embed/";

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
    debugLog("Invalid URL:", url, e);
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
  state.speakTargetUrl = location.href;
  speechSynthesis.speak(utt);
}
function stopSpeechWithSpeakCheck(speechSynthesis) {
  if(location.href != state.speakTargetUrl) return;
  speechSynthesis.cancel()
}

// 視聴ページに埋め込まれている ytInitialPlayerResponse(JSON) を DOM から読み取ります。
// メタデータ(動画長・字幕の言語)を得るためだけに使います。
//
// 【経緯】以前は ytcfg を解析して INNERTUBE_API_KEY を取り出し、youtubei/v1/player へ
// POST して player_response を得ていたが、調査の結果:
//   - その POST 応答には字幕トラックが含まれず、結局いつもこの DOM 側へフォールバックしていた
//   - 字幕本文の取得には player が生成する po_token(pot) が必須で、自前生成は非現実的(BotGuard)
// だったため、POST 一式と字幕URL生成(GetCaptionDataUrl)は廃止した。
// 字幕本文は timedtext 経路(background が観測した player 自身のリクエストURL)から取得する。
function GetPlayerResponseFromDom(){
  const el = getFirstSnapshotNode(YOUTUBE_UI_SELECTORS.initialPlayerResponseXPath);
  if(!el){ return undefined; }
  try {
    const code = el.innerText.replace("var ytInitialPlayerResponse = ", "").replace(/};var .*/, '}');
    return JSON.parse(code);
  }catch(err){
    debugLog("GetPlayerResponseFromDom parse error", err);
    return undefined;
  }
}

// fetch する前に対象URLが youtube.com のものである事を確認します。
// player_response 等の外部由来データに含まれるURLを無検証でfetchすると、
// 攻撃者が用意したページからリクエストフォージェリ(SSRF的な挙動)を誘発される
// 恐れがあるため、youtube.com 以外へのアクセスはここで拒否します。(F-4)
function IsYoutubeUrl(url){
  try {
    const u = new URL(url, location.href);
    return u.protocol === "https:" && (u.hostname === "youtube.com" || u.hostname.endsWith(".youtube.com"));
  } catch(e) {
    return false;
  }
}

// youtube.com のURLから字幕JSONを取得する共通処理。
// fetch する前に youtube.com のURLかを確認し(SSRF対策。F-4)、一度取得を試みたURLは
// excludeAccessUrlList に積んで二重取得を避けます。
// fetch 失敗・HTTPエラー・JSONパース失敗はいずれも握り込んで undefined を返します。
async function fetchYoutubeJson(url){
  if(!url){
    return undefined;
  }
  if(!IsYoutubeUrl(url)){
    debugLog("CS: refuse to fetch non-youtube url:", url);
    return undefined;
  }
  if(state.excludeAccessUrlList.includes(url)){
    return undefined;
  }
  let response;
  try {
    state.excludeAccessUrlList.push(url);
    response = await fetch(url);
  }catch(error) {
    debugLog("CS: fetch failed. url:", url, "error:", error);
    return undefined;
  }
  if(!(response && response.ok)) {
    debugLog("CS: fetch response not ok. url:", url, "status:", response?.status);
    return undefined;
  }
  let text;
  try {
    text = await response.text();
  }catch(error) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  }catch(error) {
    debugLog("CS: captionData JSON decode failed. url:", url, "text:", text);
    return undefined;
  }
}

function clearCaptionData(){
  state.captionData = {};
}

function updateCaptionFetchMetadata(playerResponse){
  // SPA遷移時、DOM の ytInitialPlayerResponse が前の動画のまま残っていることがある。
  // その場合 videoDetails は前の動画のものなので、誤った videoLengthSeconds を採ると
  // IsValidVideoDuration が永久に false になり発話に到達できなくなる。
  // よって player_response が「今見ている動画のもの」でない限りメタデータは信用しない。
  if(playerResponse?.videoDetails?.videoId !== GetVideoId()){
    return;
  }
  const lengthSeconds = VideoLengthSecondsFromPlayerResponse(playerResponse);
  if(lengthSeconds > 0){
    state.videoLengthSeconds = lengthSeconds;
  }
  state.guessedOriginalCaptionLanguage = GuessVideoAutoTranslateOriginalLanguage(playerResponse);
}

function shouldSkipCaptionFetchByLocale(storageResult){
  return state.guessedOriginalCaptionLanguage == state.playLocale && storageResult?.isDisableSpeechIfSameLocaleVideo;
}

async function FetchCaptionDataFromTimedText(videoId){
  const url = await getTimedTextUrl(state.playLocale, videoId);
  return fetchYoutubeJson(url);
}

function applyFetchedCaptionData(json, videoId){
  state.captionData = CaptionDataToTimeDict(json);
  state.currentVideoId = videoId;
}

function consumeContentScriptLoadDelay(){
  if(!state.contentScriptLoadTime){
    return 0.0;
  }
  const now = new Date();
  const delay = (now.getTime() - state.contentScriptLoadTime.getTime()) / 1000.0;
  state.contentScriptLoadTime = undefined;
  return delay;
}

async function FetchCaptionData(isForceFetch = false){
  if(state.isCaptionDataFetching){return undefined;}
  state.isCaptionDataFetching = true;
  try {
    const videoId = GetVideoId();
    if(videoId == state.currentVideoId && !isForceFetch){return undefined;}
    // 新しい動画になったので前の動画の長さを捨てる。(②)
    // player_response の取得に失敗して timedtext のみで字幕が取れた場合、
    // videoLengthSeconds が更新されず前の動画の値が残り、長さの違う動画では
    // IsValidVideoDuration が永久に false を返して発話に到達できなくなる。
    // -1 に戻しておくと、更新できなかった場合でも字幕の最終時刻ベースで判定される。
    state.videoLengthSeconds = -1;
    const storageResult = await getStorageSync(CAPTION_FETCH_STORAGE_KEYS);
    if(!isSpeechEnabled(storageResult)) {
      return undefined;
    }
    // メタデータ(動画長・推定言語)は DOM の ytInitialPlayerResponse から読む。
    updateCaptionFetchMetadata(GetPlayerResponseFromDom());
    if(shouldSkipCaptionFetchByLocale(storageResult)){
      clearCaptionData();
      return undefined;
    }
    // 字幕本文は timedtext 経路でのみ取得する(player 由来のURLは po_token 必須で取得できないため)。
    const json = await FetchCaptionDataFromTimedText(videoId);
    if(json === undefined) {
      clearCaptionData();
      return undefined;
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
    state.isCaptionDataFetching = false;
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

// player_response から .videoDetails.lengthSeconds を取り出します
function VideoLengthSecondsFromPlayerResponse(player_response){
  return player_response?.videoDetails?.lengthSeconds;
}

// 動画の「元の話し言葉」の言語コードを推定します。
// 自動生成字幕(kind=="asr")があればその言語を、無ければ先頭トラックの言語を返します。
// (旧実装は filter() の戻り値が空配列でも truthy のため、先頭トラックへのフォールバックに
//  到達できず、asr の無い動画で undefined を返していた不具合があった)
function GuessVideoAutoTranslateOriginalLanguage(player_response){
  const captionTracks = player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if(!captionTracks || captionTracks.length === 0){
    return undefined;
  }
  const asrTrack = captionTracks.find(track => track.kind === "asr");
  return (asrTrack ?? captionTracks[0])?.languageCode;
}

// 字幕のデータを後で使いやすいように加工しておきます。
function CaptionDataToTimeDict(captionData){
  let events = captionData?.events;
  if(!events){ debugLog("CaptionDataToTimeDict(): error. events not found"); return; }
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

// "ja-JP" のような locale から地域サフィックスを落として "ja" にします。
function stripLocaleSuffix(locale){
  return locale?.replace(/-.*$/, '');
}

function UpdatePlayLocale(locale){
  let l = stripLocaleSuffix(locale);
  if(l?.length > 0 && state.playLocale != l){
    state.playLocale = l;
    // locale が変わっていたなら、今読み込まれている字幕データは破棄して新しく読み直さないと謎の発話を続ける事になります。
    state.captionData = {};
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
function volumeOverride(videoElement, originalVolume, targetVolumeMagnification){
  state.overrideVolumeCount += 1;
  videoElement.volume = Math.min(Math.max(0, originalVolume * targetVolumeMagnification), 1);
}
function volumeRecover(videoElement, originalVolume){
  state.overrideVolumeCount -= 1;
  if(state.overrideVolumeCount <= 0){
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
  if(!(storageResult.isOverrideOriginalVolumeEnabled && state.originalVolume && videoElement)){
    return;
  }
  const targetVolume = GetYtpVolumePanelValue(state.originalVolume);
  volumeOverride(videoElement, targetVolume, storageResult.overrideOriginalVolumeMagnification);
  const recoverFunc = () => {
    const targetVolume = GetYtpVolumePanelValue(state.originalVolume);
    volumeRecover(videoElement, targetVolume);
  };
  utterance.onend = recoverFunc;
  utterance.onerror = recoverFunc;
  utterance.onpause = recoverFunc;
}

function resumeSpeechIfMoviePlayerActive(){
  const screen = getMoviePlayerElement();
  if (screen?.classList.contains("playing-mode")) {
    state.paused = false;
    speechSynthesis.resume();
  }
}

function buildCaptionSpeechText(captionData){
  return Object.values(captionData).reduce((acc, caption) => acc + " " + caption.segment, "");
}

function AddSpeechQueue(text, storageResult, videoElement){
  var textVoice = normalizeSpeechText(text);
  const utt = new SpeechSynthesisUtterance(textVoice);
  const setting = StorageResultToVoiceSettings(storageResult);
  applyVoiceSettingsToUtterance(utt, setting);
  utt.onerror = function(event){
    if(event.error == "interrupted") return;
    debugLog("SpeechSynthesisUtterance Event onError", event);
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
  if(state.captionData === undefined){return;}
  if(!currentTimeText){ debugLog("currentTimeText is nil"); return;}
  if(currentTimeText == state.prevSpeakTime){ return;}
  if(storageResult.isDisableSpeechIfChaptionDisabled && !CheckCaptionIsDisplaying()){ return; }
  let caption = state.captionData[currentTimeText];
  if(caption){
    state.prevSpeakTime = currentTimeText;
    AddSpeechQueue(caption.segment, storageResult, videoElement);
    return;
  }
}

function IsValidVideoDuration(duration, captionData){
  if(state.videoLengthSeconds > 0){
    return Math.abs(state.videoLengthSeconds - duration) < 4;
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

function startsWithAny(url, prefixes){
  return prefixes.some(prefix => url.indexOf(prefix) === 0);
}

function IsTargetUrlWithOption(url, storageResult){
  // watch / live は常に対象。embed(埋め込み)は設定で除外できる。
  const prefixes = [WATCH_URL_PREFIX, LIVE_URL_PREFIX];
  if(!storageResult.isDisableSpeechEmbeddedSite){
    prefixes.push(EMBED_URL_PREFIX);
  }
  return startsWithAny(url, prefixes);
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
    debugLog("CheckVideoCurrentTime videoElement is not found:", videoElement);
    return;
  }
  ensureOriginalVolume(videoElement);
  let currentTime = videoElement.currentTime;
  let duration = videoElement.duration;
  if(isNaN(duration)){return;}
  if(!IsValidVideoDuration(duration, state.captionData)){
    debugLog("CheckVideoCurrentTime is not valid VideoDuration. currentTime:", currentTime, "duration:", duration, "captionData:", state.captionData);
    return;
  }
  const textVoice = buildCaptionSpeechText(state.captionData);
  stopSpeechWithSpeakCheck(speechSynthesis);
  AddSpeechQueue(textVoice, storageResult, videoElement);
}

function ensureOriginalVolume(videoElement){
  if(typeof(state.originalVolume) == "undefined"){
    state.originalVolume = videoElement.volume;
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
    if(state.prevCheckVideoTimeText == timeText){return;}
    state.prevCheckVideoTimeText = timeText;
    CheckAndSpeech(timeText, storageResult, videoElement);
  }
}

// 再生位置を video object の .currentTime から取得して、発話が必要そうなら発話させます
async function CheckVideoCurrentTime(loadGapSecond = 0.0){
  const storageResult = await getStorageSync(VIDEO_TIME_CHECK_STORAGE_KEYS);
  if(!shouldCheckCurrentVideo(storageResult)){return;}
  let videoElement = getMainVideoElement();
  if(!videoElement){
    debugLog("CheckVideoCurrentTime videoElement is not found:", videoElement);
    return;
  }
  ensureOriginalVolume(videoElement);
  const playbackState = getVideoPlaybackState(videoElement);
  if(!playbackState.isDurationKnown){return;}
  const { currentTime, duration } = playbackState;
  if(!IsValidVideoDuration(duration, state.captionData)){
    UpdateCaptionData();
    return;
  }
  checkCurrentVideoTimeTexts(currentTime, loadGapSecond, storageResult, videoElement);
}

// "https://www.youtube.com/api/timedtext" で始まるURLがリクエストされた場合に貯めておきます。
// これの、tlang=ja  の部分を書き換えることで自動翻訳のものが取り出せる事になります。
// 取得済みのものは state.accessUrlList、以前の生成で取得済みのものは state.excludeAccessUrlList で覚えておきます。
function onUrlAccessed(url) {
  if(url.includes('https://www.youtube.com/api/timedtext') && (!state.excludeAccessUrlList.includes(url))){
    state.accessUrlList.push(url);
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

async function getTimedTextUrl(lang, videoId) {
  let filteredAccessUrlList = filterTimedTextAccessUrls(state.accessUrlList, videoId);
  if(filteredAccessUrlList.length <= 0) {
    if(shouldSkipTimedTextCollection(videoId)) {
      return undefined;
    }
    const button = getSubtitleButtonElement();

    if(state.lastSubtitleClickVideoId !== videoId) {
      await doubleClickWithDelay(button);
      state.lastSubtitleClickVideoId = videoId;
    }
    for(var i = 0; i < 10; i++){
      filteredAccessUrlList = filterTimedTextAccessUrls(state.accessUrlList, videoId);
      if(filteredAccessUrlList.length > 0){
        break;
      }
      await sleep(100);
    }
    if(filteredAccessUrlList.length <= 0){
      debugLog("CS: getTimedTextUrl() failed.", "filteredAccessUrlList:", filteredAccessUrlList, "excludeAccessUrlList", state.excludeAccessUrlList, "accessUrlList", state.accessUrlList);
      return undefined;
    }
  }
  // 現在 filteredAccessUrlList に保存されているURLのうち、最後の URL を取り出します。
  let url = findLatestTimedTextUrl(filteredAccessUrlList, state.excludeAccessUrlList, videoId);
  if(url === undefined) {
    debugLog("CS: getTimedTextUrl return undefined. url not found.", "filteredAccessUrlList:", filteredAccessUrlList, "excludeAccessUrlList", state.excludeAccessUrlList, "accessUrlList", state.accessUrlList);
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
  if(state.currentVideoId == GetVideoId()){
    CheckVideoCurrentTime().catch((e)=>{
      debugLog("CheckVideoCurrentTime got error. video time checker stop:", e);
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
  const lang = storageResult.lang;
  const voice = findSelectedVoice(speechSynthesis.getVoices(), lang, storageResult.voice);
  if(!voice){ return; }
  const l = stripLocaleSuffix(lang);
  if(l?.length > 0 && state.playLocale != l){
    state.playLocale = l;
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
    const videoId = GetVideoId();
    IsTargetUrl().then((isTargetUrl)=>{
      if(isTargetUrl){
        if(videoId == state.currentVideoId){return;}
        // UpdateCaptionData は /watch?v=... の ... が変わった時だけで良いはず
        state.contentScriptLoadTime = new Date(); // ページが変わったぽいので load time を解消しておきます
        UpdateCaptionData();
        if (!storageResult.isSpeechWithoutSyncEnabled) {
          StartVideoTimeChecker();
        }
      }else{
        StopVideoTimeChecker();
      }
    }).catch(e => {
      debugLog("ToplevelObserver: IsTargetUrl got error", e);
    });
  });
  const toplevel = document.body;
  ToplevelObserver.observe(toplevel, {
    childList: true,
    subtree: true,
  });
}

// www.youtube.com の時は toplevelobserver を仕掛けておかないと、画面遷移時に開始できない事があります。
if(location.href.indexOf(YOUTUBE_ORIGIN_PREFIX) == 0){
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
        if(location.href.indexOf(EMBED_URL_PREFIX) == 0 && !newValue){
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
    if (state.paused) stopSpeechWithSpeakCheck(speechSynthesis);
  });
}

// movie_player observer to react on pause
const screenObserver = new MutationObserver(function (mutations) {
  mutations.forEach(function (mutation) {

    // cancels speechSynthesis if url was changed
    if (mutation.attributeName === "src"){
      stopSpeechWithSpeakCheck(speechSynthesis);
      return;
    }

    if (mutation.target.classList.contains("paused-mode")) {
      if (state.paused) {
        return;
      }
      state.paused = true;
      if(speechSynthesis.speaking) {
        speechSynthesis.pause();
      }
      state.pauseTime = mutation.target.querySelector(YOUTUBE_UI_SELECTORS.videoStreamSelector).currentTime;
    }
    if (mutation.target.classList.contains("playing-mode")) {
      if (!state.paused) {
        return;
      }
      state.paused = false;
      // resumes if the time before and after the pause differs by less than 1 sec, or if undefined (videoElement is not found)
      if (Math.abs(mutation.target.querySelector(YOUTUBE_UI_SELECTORS.videoStreamSelector).currentTime - state.pauseTime) > 1){
        stopSpeechWithSpeakCheck(speechSynthesis);
      }
      else {
        speechSynthesis.resume();
      }
    }
  });
});

InitializeScreenObserver();
