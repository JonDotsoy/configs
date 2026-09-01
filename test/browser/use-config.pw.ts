import { expect, test } from "@playwright/test";

test("useConfig renders the store's initial value and re-renders on updates", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("banner-state")).toHaveText("inactive");

  await page.getByTestId("toggle").click();
  await expect(page.getByTestId("banner-state")).toHaveText("active");

  await page.getByTestId("toggle").click();
  await expect(page.getByTestId("banner-state")).toHaveText("inactive");
});

test("useConfig picks up a store update pushed from outside React", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(() => {
    (window as unknown as { bannerIsActive: { set(v: boolean): void } }).bannerIsActive.set(true);
  });

  await expect(page.getByTestId("banner-state")).toHaveText("active");
});

test("useConfig(cfg.foo) reads a configs.create() field before it resolves, then catches up", async ({
  page,
}) => {
  await page.goto("/");

  // The page's delayed source hasn't published yet: cfg.foo starts out null.
  await expect(page.getByTestId("foo-state")).toHaveText("pending");
  // ...and resolves to true once the source publishes, ~50ms later.
  await expect(page.getByTestId("foo-state")).toHaveText("true");
});
