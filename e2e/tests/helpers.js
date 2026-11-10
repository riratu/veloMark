import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The vaults' folders, to check what reached the disk.
export const vaultDir = (v = "notes") => path.join(process.env.GONOTES_E2E, v);
export const onDisk = (rel, v = "notes") => {
    try { return fs.readFileSync(path.join(vaultDir(v), rel), "utf8"); } catch (e) { return null; }
};

// Each test gets a folder of its own (dir) and makes its notes there through
// gonotes itself, so the index has them at once.
export const test = base.extend({
    dir: async ({}, use, info) => {
        await use("t" + info.testId.slice(0, 8));
    },
    note: async ({ request }, use) => {
        await use(async (rel, body, vault = "notes") => {
            const res = await request.post("/save", { form: { path: rel, body, vault }, headers: { Accept: "application/json" } });
            expect(res.ok(), await res.text()).toBeTruthy();
        });
    },
});
export { expect };

// The list page narrowed to a folder, its first note selected.
export async function openFolder(page, dir) {
    await page.goto("/?q=" + encodeURIComponent("in:" + dir));
    await expect(page.locator(".hit").first()).toBeVisible();
}
export const hits = (page) => page.locator("#results .hit");
export const toast = (page) => page.locator(".toast");
