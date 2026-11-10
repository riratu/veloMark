// Search as you type, keyboard navigation and the editor. No framework: the
// server renders everything, this only swaps the results list in place.
//
// Each part registers its listeners in init(), called here in this order:
// handlers of one event on the document run in the order they were added,
// and some leave alone what an earlier one took (e.defaultPrevented).
import * as links from "./links.js";
import * as options from "./options.js";
import * as search from "./search.js";
import * as peek from "./peek.js";
import * as upload from "./upload.js";
import * as pane from "./pane.js";
import * as keys from "./keys.js";
import { initList } from "./start.js";
import * as drag from "./drag.js";
import * as menu from "./menu.js";
import * as folders from "./folders.js";
import * as vaults from "./vaults.js";
import * as actions from "./actions.js";
import * as tour from "./tour.js";
import { initEditor } from "./editor.js";

// Installable as an app (Android, Chrome, Edge, Safari): see sw.js.
try { navigator.serviceWorker?.register("/sw.js"); } catch (e) {}

links.init();
options.init();
search.init();
peek.init();
upload.init();
pane.init();
keys.init();
initList();
drag.init();
menu.init();
folders.init();
vaults.init();
actions.init();
tour.init();
initEditor();
