package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

// pickFolder asks the desktop for a folder in its own dialog, through the
// XDG desktop portal, so drives, bookmarks and other locations are all
// there. It waits for the choice: "" when it was cancelled.
func pickFolder(ctx context.Context, title string) (string, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if err := conn.AddMatchSignal(dbus.WithMatchInterface("org.freedesktop.portal.Request"), dbus.WithMatchMember("Response")); err != nil {
		return "", err
	}
	answers := make(chan *dbus.Signal, 4)
	conn.Signal(answers)

	portal := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	opts := map[string]dbus.Variant{
		"handle_token": dbus.MakeVariant(fmt.Sprintf("gonotes%d", time.Now().UnixNano())),
		"directory":    dbus.MakeVariant(true),
		"modal":        dbus.MakeVariant(true),
	}
	var request dbus.ObjectPath
	if err := portal.CallWithContext(ctx, "org.freedesktop.portal.FileChooser.OpenFile", 0, "", title, opts).Store(&request); err != nil {
		return "", err
	}
	for {
		select {
		case <-ctx.Done():
			conn.Object("org.freedesktop.portal.Desktop", request).Call("org.freedesktop.portal.Request.Close", 0)
			return "", ctx.Err()
		case s := <-answers:
			if s.Path != request || len(s.Body) < 2 {
				continue
			}
			if code, _ := s.Body[0].(uint32); code != 0 {
				return "", nil // cancelled
			}
			results, _ := s.Body[1].(map[string]dbus.Variant)
			uris, _ := results["uris"].Value().([]string)
			if len(uris) == 0 {
				return "", nil
			}
			u, err := url.Parse(uris[0])
			if err != nil || u.Scheme != "file" {
				return "", errors.New("the dialog gave no folder on this machine")
			}
			return u.Path, nil
		}
	}
}

// pickDir opens the desktop's folder dialog for the Vaults page and answers
// with the folder picked; 204 when cancelled, 501 when there is no dialog to
// open, so the page uses its own folder list instead. It is a POST: another
// site must not be able to pop dialogs up.
func (a *App) pickDir(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	dir, err := pickFolder(ctx, "Pick the folder of your notes")
	switch {
	case err != nil:
		http.Error(w, "no folder dialog: "+err.Error(), http.StatusNotImplemented)
	case dir == "":
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"dir": shortPath(dir)})
	}
}

// shortPath writes a path in the home folder as ~/…
func shortPath(p string) string {
	home, _ := os.UserHomeDir()
	if p == home {
		return "~"
	}
	if rest, ok := strings.CutPrefix(p, home+string(filepath.Separator)); ok {
		return "~/" + filepath.ToSlash(rest)
	}
	return p
}

// places are the folder list's shortcuts: home, and the drives where the
// system puts them: /run/media and /media on Linux, /Volumes on a Mac,
// letters on Windows, the phone's storage on Android.
func places() []map[string]string {
	out := []map[string]string{{"name": "Home", "dir": "~"}}
	// A phone's storage, as Termux on Android sees it.
	if st, err := os.Stat("/storage/emulated/0"); err == nil && st.IsDir() {
		out = append(out, map[string]string{"name": "Phone", "dir": "/storage/emulated/0"})
	}
	// Windows: the drives by letter.
	if runtime.GOOS == "windows" {
		for c := 'A'; c <= 'Z'; c++ {
			d := string(c) + `:\`
			if _, err := os.Stat(d); err == nil {
				out = append(out, map[string]string{"name": string(c) + ":", "dir": d})
			}
		}
	}
	user := os.Getenv("USER")
	for _, root := range []string{"/run/media/" + user, "/media/" + user, "/mnt", "/Volumes"} {
		entries, _ := os.ReadDir(root)
		for _, e := range entries {
			if st, err := os.Stat(filepath.Join(root, e.Name())); err == nil && st.IsDir() {
				out = append(out, map[string]string{"name": e.Name(), "dir": filepath.Join(root, e.Name())})
			}
		}
	}
	return out
}

// reveal shows a file or folder in the desktop's file manager: selected in
// its folder through the FileManager1 D-Bus interface (Nautilus, Dolphin and
// the like), else its folder with xdg-open; Finder on a Mac, Explorer on
// Windows.
func reveal(file string, isDir bool) error {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("explorer", "/select,", file)
		if err := cmd.Start(); err != nil {
			return err
		}
		go cmd.Wait()
		return nil
	}
	if runtime.GOOS == "darwin" {
		cmd := exec.Command("open", "-R", file)
		if err := cmd.Start(); err != nil {
			return err
		}
		go cmd.Wait()
		return nil
	}
	if conn, err := dbus.ConnectSessionBus(); err == nil {
		defer conn.Close()
		u := (&url.URL{Scheme: "file", Path: file}).String()
		method := "org.freedesktop.FileManager1.ShowItems"
		if isDir {
			method = "org.freedesktop.FileManager1.ShowFolders"
		}
		fm := conn.Object("org.freedesktop.FileManager1", "/org/freedesktop/FileManager1")
		if fm.Call(method, 0, []string{u}, "").Err == nil {
			return nil
		}
	}
	dir := file
	if !isDir {
		dir = filepath.Dir(file)
	}
	cmd := exec.Command("xdg-open", dir)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// revealPath shows a note or a folder of the vault in the file manager.
func (v *Vault) revealPath(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	st, err := os.Stat(file)
	if err != nil {
		http.Error(w, rel+" is not there", http.StatusNotFound)
		return
	}
	if err := reveal(file, st.IsDir()); err != nil {
		http.Error(w, "no file manager to show it in: "+err.Error(), http.StatusNotImplemented)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// openLink opens a web or mail link in the desktop's default browser or mail
// program. The installed app's own window would otherwise keep it.
func openLink(w http.ResponseWriter, r *http.Request) {
	u, err := url.Parse(r.FormValue("url"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "mailto") {
		http.Error(w, "only web and mail links open outside", http.StatusBadRequest)
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String())
	case "darwin":
		cmd = exec.Command("open", u.String())
	default:
		cmd = exec.Command("xdg-open", u.String())
		if _, err := exec.LookPath("xdg-open"); err != nil {
			cmd = exec.Command("termux-open-url", u.String())
		}
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, "no browser to open it in: "+err.Error(), http.StatusNotImplemented)
		return
	}
	go cmd.Wait()
	w.WriteHeader(http.StatusNoContent)
}
