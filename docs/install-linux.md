# gonotes on Linux

[← all systems](../README.md#install)

## Build and install

```sh
CGO_ENABLED=0 go build -o gonotes .
install -Dm755 gonotes ~/.local/bin/gonotes
install -Dm644 web/static/icon.svg ~/.local/share/icons/hicolor/scalable/apps/gonotes.svg
```

## Run it in the background

A systemd user service starts it with the session and restarts it if it
stops. `~/.config/systemd/user/gonotes.service`:

```ini
[Unit]
Description=gonotes

[Service]
ExecStart=%h/.local/bin/gonotes
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now gonotes
```

## Open it as an app

Chrome, Chromium and Edge install it from the page itself: ⋮ → *Cast, save
and share* → *Install page as app*. Or write a launcher, which opens gonotes
in a window of its own, without tabs or address bar, in the app list and the
dock. `~/.local/share/applications/gonotes.desktop`:

```ini
[Desktop Entry]
Name=Notes
Exec=chromium --app=http://127.0.0.1:8090 --start-maximized
Icon=gonotes
Type=Application
Categories=Office;
StartupWMClass=chrome-127.0.0.1__-Default
```

`Ctrl+Q` closes the window (the server keeps running, so the next start is
instant). With NixOS and Home Manager, put both in the config instead
(`systemd.user.services.gonotes`, `xdg.desktopEntries.gonotes`), or a rebuild
may drop them.

## Update

```sh
CGO_ENABLED=0 go build -o gonotes . && install -m755 gonotes ~/.local/bin/gonotes && systemctl --user restart gonotes
```

Reload the window with `Ctrl+Shift+R` when the editor changed.

## What uses the desktop

*Browse…* on the Vaults page opens the desktop's own folder dialog (the XDG
desktop portal), and *Show in Files* opens the file manager (FileManager1, or
`xdg-open`). Both talk to the session D-Bus, which systemd hands to user
services. Without one, Browse… shows gonotes' own folder list, with home and
mounted drives.

