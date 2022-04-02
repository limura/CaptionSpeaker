function isTargetUrl(url){
  if(!url){return false;}
  return url.indexOf("https://www.youtube.com/watch") != -1;
}

var status = "stop";
function StatusStartSpeech(){
  status = "speech";
}
function StatusEndSpeech(){
  status = "stop";
}

function RunStartSpeech(tabId, url, kickType){
  chrome.tabs.sendMessage(tabId, {
    "type": kickType,
  });
  StatusStartSpeech();
}

function RunStopSpeech(tabId){
  chrome.tabs.sendMessage(tabId, {"type": "StopSpeech"});
  StatusEndSpeech();
}

function KickSpeech(tabId, url){
  if(status == "speech"){
    RunStopSpeech(tabId);
    return;
  }
  RunStartSpeech(tabId, url, "KickSpeech");
}

function AssignPageActionIcon(tabId, isEnabled){
  if(isEnabled){
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

function enableActionButton(tabId){
  chrome.action.enable(tabId);
  chrome.storage.sync.get(["isEnabled"], (result)=>{
    AssignPageActionIcon(tabId, result.isEnabled);
  });
}

function disableActionButton(tabId){
  chrome.action.disable(tabId);
}

chrome.tabs.onUpdated.addListener(function(tabId){
  chrome.tabs.get(tabId, function(tab){
    let url = tab?.url;
    if(!isTargetUrl(url)){
      disableActionButton(tabId);
      return;
    }
    enableActionButton(tabId);
  });
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

function StartSpeech(){
  RunInCurrentTab(function(tab){
    RunStartSpeech(tab.id, tab.url, "KickSpeech");
  });
}
function StopSpeech(){
  RunInCurrentTab(function(tab){
    RunStopSpeech(tab.id);
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
    case "StartSpeech":
      StatusStartSpeech();
      break;
    case "EndSpeech":
      StatusEndSpeech();
      break;

    case "RunStartSpeech":
      StartSpeech();
      break;
    case "RunStopSpeech":
      StopSpeech();
      break;
    case "SettingsUpdated":
      SettingsUpdated();
      break;
    default:
      break;
    }
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

chrome.storage.sync.get(["voice"], (data)=>{
  if(!("voice" in data) || type(data["voice"]) != "string" || data["voice"].length <= 0){
    chrome.runtime.openOptionsPage();
  }
});
