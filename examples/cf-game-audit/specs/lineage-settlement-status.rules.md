# Lineage settlement Playwright generation rules

- Import and use `gotoApp(page)`; never call `page.goto()` in a test.
- Intercept `game-market-listings` and derive the exact `asset_id` from its JSON body.
- Fulfill that listing once with HTTP 403, `decision: asset_lineage_revoked`, and a
  well-formed `lineage_settlement` in `quarantined` / `appeal_open` state.
- Intercept `game-asset-lineage-status`; return `expired` on the first explicit
  refresh and `finalized` on the second.
- Prefer role and exact text locators. Do not use CSS, XPath, canvas coordinates,
  screenshots, or fixed sleeps.
- Assert every state in order: provisional, finalized, quarantined, checking,
  expired, then finalized again with listing enabled.
- Use Playwright auto-waiting for asynchronous transitions.
- Keep one deterministic smoke scenario with sparse comments.
