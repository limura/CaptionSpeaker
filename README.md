CaptionSpeaker は youtube に設定された字幕のうち、指定された言語の字幕があった場合に、それを発話させる事で耳から聞くことができるようにする chrome extension です。

Chrome webstore で[公開されています](https://chrome.google.com/webstore/detail/captionspeaker/infafaffjndfcflcoemolnggghgoodce)。

# 使い方

1. CaptionSpeaker のアイコンを右クリックして設定(オプション)を開き、話者設定を適切に設定してsaveする(標準設定では発話に失敗する場合があるので必ず行って下さい)
2. Youtube で字幕を発話させたい動画を開く
3. CaptionSpeaker のアイコンをクリックして字幕の発話を有効にする(緑色のアイコンになっていればONになっています)
4. 動画の再生を開始する(字幕が表示されるタイミングで発話が開始されます)

字幕の発話を停止したい場合は CaptionSpeaker のアイコンをクリックして字幕の発話をOFFにする事で停止できます。

発話時の話者は最初はブラウザの標準設定になっています。例えば日本語環境だと日本語話者になっているので、英語で発話させたい時などは設定ページ(アイコンを右クリックしてオプションを選択するか、アイコンをクリックしてOptionsを選択)で設定してください。
設定ページでは読み上げの速度等も変更できます。

発話時の話者の言語(ロケール)を変えると、その言語の字幕を発話するように努力します(時々失敗します)。

# 更新履歴

## Version 1.0
最初のリリース

## Version 1.1
- 新しく発話する時に前の発話を止める オプションを追加
- 発話設定の言語と同じ言語の字幕がdefaultの場合、発話をしない オプションを追加

## Version 1.2
- 読み上げをOFFにした時に、発話状態であれば発話をやめるように
- 読み上げが少し遅れる場合がある問題に対処

## Version 1.3
- 「発話設定の言語と同じ言語の字幕」の判定基準を少し変更

## Version 1.4
- 「字幕が表示されている時だけ読み上げを行うようにする」設定項目を追加

## Version 1.4.2
- 字幕を読み込めなくなっていた問題を修正(2020/11/26)

## Version 1.4.3
- 字幕を読み込めない場合が残っていた問題を修正(2020/11/28)

## Version 2.0.0 (2022/04)
- Manifest V3 に対応させた
- チャンネル(www.youtube.com/channel/...)やプレイリスト(www.youtube.com/playlist?list=...)から動画のページに遷移した時に発話しない問題を解消
- www.youtube.com以外のページへの埋込 youtube動画(iframe で www.youtube.com/embed... が取り込まれるタイプのもの)に対応(なお、youtube内で「キューに追加」した時に表示されるミニプレイヤーには非対応です)
- 「発話中に元動画の音量を下げる」設定を追加

## Verson 2.0.1 (2022/05)
- ブラウザの言語設定(window.navigator.language)と読み上げ対象の言語が違っている場合に、ブラウザの言語設定側の言語を発話しようとする問題を修正

## Version 2.0.2 (2022/06)
- 字幕を取得できなかった時に次点の情報を取りに行く事で、字幕が取得できなくなる可能性を減らした

## Version 2.0.3 (2022/06)
- Version 2.0.2 で入れた次点の情報を取りに行く部分で、取得し損なう場合があった問題に対処

## Version 2.0.4 (?)
- 動画の再生を止めた時に発話も止まるようになります (Thanks @RonnieBlade)
- 「オプション」に「時刻同期をせずに発話するようにする」のON/OFF設定が追加されます (Thanks @billythekidz)

# 既知の問題

macOS Catalina では標準の話者での発話が失敗することがあるようです。
設定ページでテスト発話させてみて、実際に発話できることを確認できた話者を設定することで回避することができます。
