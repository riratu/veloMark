import { $, $$, call, label, typing, vault } from "./dom.js";
import { leaveFolders } from "./folders.js";
import { closePalette } from "./search.js";
import { toast } from "./toast.js";

// ---- switch vaults ----
// v opens the menu: 1–9 or ↑↓ and Enter pick a vault, Esc closes it.
const vaultBtn = $("#vault");
const vaultMenu = $("#vaultmenu");
let vsel = -1;
const vaultLinks = () => $$("a[data-vault]", vaultMenu);
function pickVault(i) {
    const all = vaultLinks();
    vsel = (i + all.length) % all.length;
    all.forEach((a, j) => a.classList.toggle("cur", j === vsel));
}
function openVaults() {
    closePalette();
    leaveFolders();
    vaultMenu.hidden = false;
    vaultBtn.setAttribute("aria-expanded", "true");
    pickVault(Math.max(0, vaultLinks().findIndex((a) => a.classList.contains("on"))));
}
function closeVaults() {
    if (!vaultMenu || vaultMenu.hidden) return;
    vaultMenu.hidden = true;
    vaultBtn.setAttribute("aria-expanded", "false");
    vsel = -1;
}

function vaultKeys(e) {
    if (!vaultMenu) return false;
    if (vaultMenu.hidden) {
        if (e.key !== "v" || typing(document.activeElement)) return false;
        e.preventDefault();
        openVaults();
        return true;
    }
    const all = vaultLinks();
    if (/^[1-9]$/.test(e.key) && all[e.key - 1]) location.href = all[e.key - 1].href;
    else switch (e.key) {
        case "ArrowDown": case "j": pickVault(vsel + 1); break;
        case "ArrowUp": case "k": pickVault(vsel - 1); break;
        case "Enter": location.href = all[vsel].href; break;
        case "Escape": case "v": closeVaults(); vaultBtn.focus(); break;
        case "Tab": closeVaults(); return false;
        default: return false;
    }
    e.preventDefault();
    return true;
}

// ---- the Vaults page: a folder picker for each vault ----
// Browse… opens the folders where the field points (or home): click one
// to go in, ↑ to go up, Use this folder to take it.
async function browseTo(field, dir) {
    const picker = $(".picker", field);
    const res = await call("/browse?dir=" + encodeURIComponent(dir));
    if (!res.ok) {
        if (dir !== "~") return browseTo(field, "~"); // a folder not made yet
        toast((await res.text()).trim());
        return;
    }
    const { dir: here, parent, dirs, places = [] } = await res.json();
    picker.replaceChildren();
    // Home and the drives, to jump to.
    const jump = document.createElement("div");
    jump.className = "picker-places";
    for (const p of places) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = p.name;
        b.title = p.dir;
        b.addEventListener("click", () => browseTo(field, p.dir));
        jump.append(b);
    }
    const head = document.createElement("div");
    head.className = "picker-head";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn ghost";
    up.textContent = "↑";
    up.title = "Up a folder";
    up.disabled = !parent;
    up.addEventListener("click", () => browseTo(field, parent));
    const at = document.createElement("code");
    at.textContent = here;
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn primary";
    use.textContent = "Use this folder";
    use.addEventListener("click", () => {
        $("input", field).value = here;
        picker.hidden = true;
    });
    head.append(up, at, use);
    const ul = document.createElement("ul");
    for (const d of dirs) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = d;
        b.addEventListener("click", () => browseTo(field, (here === "/" ? "" : here) + "/" + d));
        li.append(b);
        ul.append(li);
    }
    if (!dirs.length) ul.innerHTML = '<li class="muted">No folders in here</li>';
    picker.append(jump, head, ul);
    picker.hidden = false;
}

// ---- the Vaults page: gradients follow their sliders ----
// The page takes on a vault's colours while they are picked, when it is
// the vault it shows.
function showGradient(row) {
    const [a, b] = $$("input[type=range]", row).map((r) => r.value);
    row.style.setProperty("--g1", a);
    row.style.setProperty("--g2", b);
    if (row.dataset.orig && row.dataset.orig === vault) {
        document.documentElement.style.setProperty("--hue-accent", a);
        document.documentElement.style.setProperty("--hue-accent2", b);
    }
}

export function init() {
    vaultBtn?.addEventListener("click", () => (vaultMenu.hidden ? openVaults() : closeVaults()));
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".vaults")) closeVaults(); });
    // Browse… opens the desktop's own folder dialog, drives and all; where
    // there is none, the folder list here.
    document.addEventListener("click", async (e) => {
        const b = e.target.closest?.("[data-browse]");
        if (!b) return;
        const field = b.closest(".folderfield");
        const picker = $(".picker", field);
        if (!picker.hidden) { picker.hidden = true; return; }
        const label = b.textContent;
        b.disabled = true;
        b.textContent = "Waiting for the dialog…";
        try {
            const res = await call("/pickdir", { method: "POST" });
            if (res.status === 200) { $("input", field).value = (await res.json()).dir; return; }
            if (res.status === 204) return; // cancelled
            browseTo(field, $("input", field).value.trim() || "~");
        } finally {
            b.disabled = false;
            b.textContent = label;
        }
    });
    document.addEventListener("keydown", (e) => {
        const picker = e.key === "Escape" && e.target.closest?.(".folderfield")?.querySelector(".picker:not([hidden])");
        if (picker) { e.preventDefault(); picker.hidden = true; }
    });
    document.addEventListener("input", (e) => {
        const row = e.target.closest?.(".vaultrow");
        if (row && e.target.type === "range") showGradient(row);
    });
    document.addEventListener("click", (e) => {
        const p = e.target.closest?.("[data-preset]");
        if (!p) return;
        const row = p.closest(".vaultrow");
        const [a, b] = p.dataset.preset.split(",");
        const [r1, r2] = $$("input[type=range]", row);
        r1.value = a;
        r2.value = b;
        showGradient(row);
    });
}

export { vaultBtn, vaultMenu, vsel, vaultLinks, pickVault, openVaults, closeVaults, vaultKeys, browseTo, showGradient };
