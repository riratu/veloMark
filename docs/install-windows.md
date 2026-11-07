# gonotes on Windows

[← all systems](../README.md#install)

## Build and install

On any machine with Go 1.27. `-H=windowsgui` keeps it from opening a console
window of its own:

```sh
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags -H=windowsgui -o gonotes.exe .
```

Put `gonotes.exe` in `%LOCALAPPDATA%\Programs\gonotes\`. Windows may warn the
first time, since the program is not signed: *More info* → *Run anyway*.

## Run it at login

Press `Win+R`, type `shell:startup`, and put a shortcut to `gonotes.exe` in
the folder that opens. It starts with every login, without a window.

Open `http://127.0.0.1:8090`; the first start asks for the notes folder. The
vaults are kept in `%APPDATA%\gonotes\vaults.json`.

## Open it as an app

- **Edge**: ⋯ → *Apps* → *Install this site as an app*.
- **Chrome**: ⋮ → *Cast, save and share* → *Install page as app*.

It gets a window, a taskbar icon and a Start menu entry.

## Update

Quit gonotes in the Task Manager, replace `gonotes.exe`, and start it again
(or log in again).

## What is different

*Browse…* shows gonotes' own folder list, with your home folder and the drive
letters; *Show in Explorer* opens Explorer with the note selected.
