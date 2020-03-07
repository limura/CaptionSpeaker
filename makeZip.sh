#!/bin/sh

rm -f CaptionSpeaker.zip
zip -r CaptionSpeaker.zip CaptionSpeaker/*.js CaptionSpeaker/*.json CaptionSpeaker/_locales/*/messages.json CaptionSpeaker/icon/Icon*.png CaptionSpeaker/*.html
