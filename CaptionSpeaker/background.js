function AssignPageActionIcon(tabId, isEnabled){
  if(isEnabled || typeof isEnabled == "undefined"){
    chrome.action.setIcon({tabId: tabId, path: {"19": "icon/Icon19.png", "24": "icon/Icon24.png", "32": "icon/Icon32.png"}});
  }else{
    chrome.action.setIcon({tabId: tabId, path: {"19": "icon/IconDark19.png", "24": "icon/IconDark24.png", "32": "icon/IconDark32.png"}});
  }
}

function EnableSpeechSetting(tabId){
  AssignPageActionIcon(tabId, true);
  chrome.storage.sync.set({"isEnabled": true}, ()=>{chrome.tabs.sendMessage(tabId, {"type": "LoadBooleanSettings"});});
}
function DisableSpeechSetting(tabId){
  AssignPageActionIcon(tabId, false);
  chrome.storage.sync.set({"isEnabled": false}, ()=>{chrome.tabs.sendMessage(tabId, {"type": "LoadBooleanSettings"});});
}

chrome.action.onClicked.addListener((tab)=>{
  chrome.storage.sync.get(["isEnabled"], (result)=>{
    let isEnabled = result.isEnabled;
    if(isEnabled){
      DisableSpeechSetting(tab.id);
    }else{
      EnableSpeechSetting(tab.id);
    }
  });
});

function updateActionButtonIcon(tabId){
  chrome.storage.sync.get(["isEnabled"], (result)=>{
    AssignPageActionIcon(tabId, result.isEnabled);
  });
}

chrome.tabs.onActivated.addListener((info)=>{
  updateActionButtonIcon(info.tabId);
});

function RunInCurrentTab(func){
  if(!func){
    return;
  }
  chrome.tabs.query({
    currentWindow: true,
    active: true
  }, function(tabArray){
    if(tabArray.length > 0){
      func(tabArray[0]);
    }
  });
}

function SettingsUpdated(){
  RunInCurrentTab(function(tab){
    chrome.tabs.sendMessage(tab.id, {"type": "SettingsUpdated"});
  });
}

chrome.runtime.onMessage.addListener(
  function(request, sender, sendResponse){
    switch(request.type){
    case "SettingsUpdated":
      SettingsUpdated();
      break;
    default:
      break;
    }
    sendResponse();
    return true;
  }
);

chrome.commands.onCommand.addListener(function(command) {
  switch(command){
  case "enableEvent":
    chrome.tabs.query({"active": true}, (tabs) => {
      for(i in tabs){
        EnableSpeechSetting(tabs[i].id);
      }
    });
    break;
  case "disableEvent":
    chrome.tabs.query({"active": true}, (tabs) => {
      for(i in tabs){
        DisableSpeechSetting(tabs[i].id);
      }
    });
    break;
  }
});

// Version 1.* の頃のデータが Version 2.* で manifest v3 に変わったことで読み込めなくなっている場合があるのでそういう感じの物を検知したり、クリーンインストールした時とかには設定ページを強制的に開くようにします。
chrome.storage.sync.get(["rate"], (data)=>{
  if(!("rate" in data) || typeof(data["rate"]) != "string" || Number(data["rate"]) <= 0 || Number(data["rate"]) > 10){
    chrome.runtime.openOptionsPage();
  }
});

// そのタブから読み込まれたURLをcontent scriptに通知します。
//chrome.webRequest.onBeforeRequest.addListener(
chrome.webRequest.onCompleted.addListener(
  function (details) {
    const { tabId, url, statusCode } = details;
	if (statusCode != 200) { return; }

    // tabId -1 は拡張機能や非タブのリクエストなので除外
    if (tabId >= 0) {
	 if (!url.includes('https://www.youtube.com/api/timedtext')) {
	  return;
	 }
      //console.log(`Tab ${tabId} accessed: ${url}`);

      chrome.tabs.sendMessage(tabId, {
        type: "url_accessed",
        url: url
      });
    }
  },
  {
    urls: ["https://www.youtube.com/api/timedtext*"]
  }
);