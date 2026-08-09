# Audit Survivors Playwright generation rules

- Import and use `gotoApp(page)`; never call `page.goto()` in a test.
- Prefer role, label, and exact observed text locators.
- Do not use CSS selectors, XPath, canvas coordinates, or fixed sleeps.
- Assert the provisional disabled state before waiting for authority completion.
- Assert the observed enabled `マーケットへ出品` button and `finalized` item metadata.
- Submit the listing and assert the observed enabled `出品を取り消す` state.
- Cancel the listing, assert the disabled `取消中` state while the response is held,
  then assert `マーケットへ出品` and `finalized` metadata return.
- Use Playwright auto-waiting assertions for every asynchronous transition.
- Keep one smoke scenario and sparse comments.
- Do not weaken the test by making authority completion optional.
- Do not add screenshots to this behavior-only test.
