// The tests run against a gonotes built from this tree, on two vaults in a
// temporary folder: "notes", and "job" to move notes to.
//
// On NixOS, Playwright's own browsers do not run: CHROMIUM=$(which chromium)
// uses the system's. GONOTES=path/to/gonotes skips the build.
import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The config is read again in each worker; the folder is made once and
// handed on in the environment.
if (!process.env.GONOTES_E2E) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gonotes-e2e-"));
    for (const v of ["notes", "job"]) fs.mkdirSync(path.join(tmp, v));
    process.env.GONOTES_E2E = tmp;
}
const tmp = process.env.GONOTES_E2E;
const port = 8097;
const bin = process.env.GONOTES || path.join(tmp, "gonotes");
const build = process.env.GONOTES ? "" : `go build -o ${bin} . && `;

export default defineConfig({
    testDir: "tests",
    // One server for all: each test keeps to a folder of its own.
    workers: 1,
    timeout: 20_000,
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        launchOptions: process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
        trace: "retain-on-failure",
    },
    webServer: {
        command: `cd .. && ${build}${bin} -addr 127.0.0.1:${port} -config ${tmp}/vaults.json -dir notes=${tmp}/notes -dir job=${tmp}/job`,
        url: `http://127.0.0.1:${port}/`,
        timeout: 120_000,
        reuseExistingServer: false,
    },
});
