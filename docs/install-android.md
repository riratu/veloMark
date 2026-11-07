# gonotes on Android

[← all systems](../README.md#install)

Android has no place for a server of its own, but [Termux](https://termux.dev)
does: a Linux shell as an app. gonotes runs in it as it is, and Chrome
installs its page as an app with an icon on the home screen. The notes stay a
folder on the phone, synced like everywhere else.

## 1. The notes on the phone

Sync the notes folder to the phone first, both ways: [Syncthing-Fork](https://f-droid.org/packages/com.github.catfriend1.syncthingandroid/)
does it into any folder you pick (e.g. `Notes` in the phone's storage). The
Nextcloud app keeps files in its own folder and syncs a folder both ways only
with *Sync* turned on for it.

## 2. Termux

Install Termux **from F-Droid** (the Play Store version is outdated), open
it, and let it reach the phone's storage:

```sh
termux-setup-storage
```

## 3. gonotes

Build it on the computer for the phone's processor:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o gonotes-android .
```

Copy `gonotes-android` to the phone (e.g. into *Downloads*, or `adb push
gonotes-android /sdcard/Download/`), then in Termux:

```sh
cp ~/storage/downloads/gonotes-android ~/gonotes && chmod +x ~/gonotes
~/gonotes
```

It has to live in Termux's home: Android does not run programs from shared
storage.

## 4. The app

Open Chrome at `http://127.0.0.1:8090`. The welcome page asks for the notes
folder: *Browse…* → *Phone* → the synced folder. Then ⋮ → *Add to Home
screen* → *Install*: gonotes opens full screen, from its own icon.

## 5. Keep it running

Android stops apps it thinks idle. To keep gonotes there:

- in Android's settings, turn battery optimisation off for Termux;
- install **Termux:Boot** (also from F-Droid), open it once, and start
  gonotes with the phone, holding a wake lock:

```sh
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/gonotes <<'SH'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
exec ~/gonotes
SH
chmod +x ~/.termux/boot/gonotes
```

## Update

Copy the new `gonotes-android` over as in step 3, stop the old one
(`pkill gonotes`), and start it again (or restart the phone).

## What is different

Tap a note to open it, ← to go back; the folders and tags are behind the two
buttons at the top. *Browse…* shows gonotes' own folder list with a *Phone*
shortcut; *Show in Files* finds no file manager to open and says so.
