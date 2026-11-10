// The main ways through the app: search, open and write, make, delete,
// move, each with its Undo.
import { test, expect, onDisk, openFolder, hits, toast } from "./helpers.js";

test("the list narrows as you type", async ({ page, dir, note }) => {
    await note(`${dir}/alpha.md`, "# Alpha\nabout deploys\n");
    await note(`${dir}/beta.md`, "# Beta\nsomething else\n");
    await openFolder(page, dir);
    await expect(hits(page)).toHaveCount(2);
    await page.locator("#q").press("End");
    await page.locator("#q").pressSequentially(" deploys");
    await expect(hits(page)).toHaveCount(1);
    await expect(hits(page).first()).toHaveAttribute("data-path", `${dir}/alpha.md`);
    // The address follows, so the search can be bookmarked.
    await expect(page).toHaveURL(/deploys/);
});

test("arrows pick a row and the note shows under the list", async ({ page, dir, note }) => {
    await note(`${dir}/a.md`, "first note\n");
    await note(`${dir}/b.md`, "second note\n");
    await openFolder(page, dir);
    await expect(hits(page).nth(0)).toHaveClass(/\bsel\b/);
    await page.keyboard.press("ArrowDown");
    await expect(hits(page).nth(1)).toHaveClass(/\bsel\b/);
    const title = await hits(page).nth(1).locator(".title").textContent();
    await expect(page.locator("#peek .peek-title")).toHaveText(title);
});

test("Enter opens the note in place, typing saves it, Esc goes back", async ({ page, dir, note }) => {
    await note(`${dir}/write.md`, "start\n");
    await openFolder(page, dir);
    await page.keyboard.press("Enter");
    await expect(page.locator("body")).toHaveClass(/\bfocus\b/);
    await expect(page).toHaveURL(/open=/);
    await page.locator("#peek .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("more words");
    await expect(page.locator("#peek .peek-state")).toHaveText("Saved");
    expect(onDisk(`${dir}/write.md`)).toContain("more words");
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/\bfocus\b/);
    await expect(page.locator("#q")).toBeFocused();
});

test("Enter with nothing found makes a note of that name", async ({ page, dir, note }) => {
    await note(`${dir}/other.md`, "x\n");
    await openFolder(page, dir);
    await page.locator("#q").fill(`in:${dir} Fresh idea`);
    await expect(page.locator("#results .empty")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("body")).toHaveClass(/\bfocus\b/);
    await expect.poll(() => onDisk(`${dir}/Fresh idea.md`)).not.toBeNull();
});

test("the edit page saves by itself and Esc closes it", async ({ page, dir, note }) => {
    await note(`${dir}/edited.md`, "old\n");
    await openFolder(page, dir);
    await page.locator("#q").blur();
    await page.keyboard.press("e");
    await expect(page).toHaveURL(/\/edit\//);
    await page.locator("#editor .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("new line");
    await expect(page.locator("#savestate")).toHaveText("Saved");
    expect(onDisk(`${dir}/edited.md`)).toContain("new line");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/n\//);
});

test("Delete moves a note to the trash; Undo brings it back", async ({ page, dir, note }) => {
    await note(`${dir}/stays.md`, "hi\n");
    await note(`${dir}/gone.md`, "bye\n"); // the newest, first and selected
    await openFolder(page, dir);
    await page.locator("#q").press("End");
    await page.keyboard.press("Delete");
    await expect(toast(page)).toContainText("Deleted gone.md");
    await expect(hits(page)).toHaveCount(1);
    expect(onDisk(`${dir}/gone.md`)).toBeNull();
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(hits(page)).toHaveCount(2);
    expect(onDisk(`${dir}/gone.md`)).toBe("bye\n");
});

test("Ctrl+Z takes back the last step", async ({ page, dir, note }) => {
    await note(`${dir}/two.md`, "2\n");
    await note(`${dir}/one.md`, "1\n"); // the newest, first and selected
    await openFolder(page, dir);
    await page.locator("#q").blur();
    await page.keyboard.press("Delete");
    await expect(hits(page)).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(hits(page)).toHaveCount(2);
    expect(onDisk(`${dir}/one.md`)).toBe("1\n");
});

test("Shift marks several notes, and they are deleted together", async ({ page, dir, note }) => {
    for (const n of ["a", "b", "c"]) await note(`${dir}/${n}.md`, n + "\n");
    await openFolder(page, dir);
    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator("#results .hit.marked")).toHaveCount(2);
    await page.locator("#q").press("End");
    await page.keyboard.press("Delete");
    await expect(toast(page)).toContainText("Deleted 2 notes");
    await expect(hits(page)).toHaveCount(1);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(hits(page)).toHaveCount(3);
});

test("a note dragged onto a folder moves there; Undo moves it back", async ({ page, dir, note }) => {
    await note(`${dir}/move.md`, "m\n");
    await note(`${dir}/sub/here.md`, "h\n");
    await openFolder(page, dir);
    await page.locator(`.hit[data-path="${dir}/move.md"]`).dragTo(page.locator(`.facets a[data-dir="${dir}/sub"]`));
    await expect(toast(page)).toContainText(`Moved to ${dir}/sub`);
    await expect.poll(() => onDisk(`${dir}/sub/move.md`)).toBe("m\n");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => onDisk(`${dir}/move.md`)).toBe("m\n");
});

test("m on a folder from the keyboard moves the selected note there", async ({ page, dir, note }) => {
    await note(`${dir}/k.md`, "k\n");
    await note(`${dir}/dest/x.md`, "x\n");
    await openFolder(page, dir);
    await page.locator("#q").blur();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".side.kbd")).toBeVisible();
    // Walk down to the folder.
    const target = page.locator(`.facets a[data-dir="${dir}/dest"]`);
    for (let i = 0; i < 50 && !(await target.evaluate((a) => a.classList.contains("cur"))); i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("m");
    await expect.poll(() => onDisk(`${dir}/dest/k.md`)).toBe("k\n");
});

test("a note dragged onto another vault goes there; Undo brings it back", async ({ page, dir, note }) => {
    await note(`${dir}/travel.md`, "t\n");
    await note(`${dir}/stay.md`, "s\n");
    await openFolder(page, dir);
    // Over the vault button the menu opens, then onto the other vault.
    await page.locator(`.hit[data-path="${dir}/travel.md"]`).hover();
    await page.mouse.down();
    await page.locator("#vault").hover();
    await page.locator("#vault").hover({ position: { x: 5, y: 5 } });
    await expect(page.locator("#vaultmenu")).toBeVisible();
    await page.locator('#vaultmenu a[data-vault="job"]').hover();
    await page.mouse.up();
    await expect(toast(page)).toContainText("Moved to job");
    await expect.poll(() => onDisk(`${dir}/travel.md`)).toBeNull();
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => onDisk(`${dir}/travel.md`)).toBe("t\n");
});
