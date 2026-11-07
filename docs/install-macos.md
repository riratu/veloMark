# gonotes on macOS

[← all systems](../README.md#install)

## Build and install

On any machine with Go 1.27 (`arm64` for Apple silicon, `amd64` for Intel):

```sh
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o gonotes .
mkdir -p ~/.local/bin && cp gonotes ~/.local/bin/
```

A program built on the Mac itself starts as it is. One copied from elsewhere
may be held back by Gatekeeper the first time: `xattr -d com.apple.quarantine
~/.local/bin/gonotes` lets it run.

## Run it in the background

A launchd agent starts it at login and starts it again if it stops.
`~/Library/LaunchAgents/ch.gonotes.plist` (put your user name in the path):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ch.gonotes</string>
  <key>ProgramArguments</key>
  <array><string>/Users/YOU/.local/bin/gonotes</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/gonotes.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ch.gonotes.plist
```

Open `http://127.0.0.1:8090`; the first start asks for the notes folder.

## Open it as an app

- **Safari** (macOS 14 or later): File → *Add to Dock*.
- **Chrome / Edge**: ⋮ → *Cast, save and share* → *Install page as app*.

It gets a window, a Dock icon and `⌘Q` of its own; the server keeps running.

## Update

```sh
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o gonotes . && cp gonotes ~/.local/bin/ \
  && launchctl kickstart -k gui/$(id -u)/ch.gonotes
```

## What is different

*Browse…* shows gonotes' own folder list, with your home folder and the drives
in `/Volumes`; *Show in Finder* opens Finder with the note selected.
