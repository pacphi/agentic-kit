# Navigation memory for the v5 workbench

## Recommendation

Give every deep jump a way back, and never discard state the person did not ask to discard.

- **A push/pop trail, five visits deep.** Back, Forward and the trail return to any of the five most recent earlier visits. A pinned **Start** returns to how the session began, even after it has dropped off the trail.
- **Remembered views.** Each place keeps its search, filters, expanded sections and last-used control. Each area reopens its last tab.
- **Parked work.** Drafts, staged collections, unsaved input, schedule drafts and setup progress stay with their machine scope. They survive navigation and reload.
- **Explicit resets only.** Clear search, All categories, Discard draft, Clear trail and a confirmed Reset demo state are the only controls that clear state.

Try it in the [latest workbench preview](previews/management-workbench.html). This is a mockup revision on the research branch. Data and operations remain illustrative, and nothing changes on your machine.

## Audit: where the workbench lost your place

The shared workbench captured at [`b8e77f7`][base] had 13 points where navigating discarded state or sent the person somewhere they had not chosen. Line links point to that revision.

| # | Path | What happened at `b8e77f7` | Now |
|---|---|---|---|
| 1 | Leave Settings for another area | The settings search was cleared ([L278]) | Search, category and filters are kept |
| 2 | Settings → **All categories** or a category | Category, component filter and search were cleared; choosing a category reset the entry kind ([L164], [L165]). The category menu also cleared the search ([L185]) | Only the category changes |
| 3 | Settings search → open a result | The search was replaced by the result's category and default filters ([L145]); the result list was gone | The detail opens over the results. Close returns to them, with focus on the result |
| 4 | Open the panel map | The map search was cleared ([L281]) | The map search is kept |
| 5 | Change page or tab with a detail open | The detail closed with no way back to it ([L278], [L281]) | The detail is a visit; Back reopens it |
| 6 | Exit setup | Always opened Manage › Components, not where setup started; finishing setup discarded its progress ([L281]) | Returns to the page setup was opened from. Resume keeps the step |
| 7 | Reopen a collection editor | Rebuilt from saved values; unstaged records were lost ([L153]) | Unstaged records are kept per scope |
| 8 | Any re-render | Expanded sections collapsed; focus and position were lost ([L279]) | Sections, last-used control and position are restored |
| 9 | Return to an area | Always opened its first tab ([L278]) | Opens the last tab used |
| 10 | Change machine scope with a draft | Blocked until the draft was applied or discarded ([L282]) | The draft is parked with its scope, and a banner offers to switch back |
| 11 | Change machine scope during setup | Setup restarted at step 1 ([L282]) | Each scope keeps its own setup progress |
| 12 | Press Escape | Hid the detail and dropped keyboard focus to the page body ([L284]) | Works like Close: pops the detail and returns focus to its opener |
| 13 | Reload | Only page, tab, scope, attention focus and settings filters survived ([L280]) | Trail, views, drafts, simulated results and operation status are restored within the storage budget |

### Deep jumps in the user paths

These entry points move across areas or into a detail. Each is now a recorded visit:

- Overview attention cards: **Inspect**, **Preview fix** and **Review drift** (Manage › Drift).
- The attention banner shown on most pages, which opens a finding.
- Panel map → panel detail → its **canonical destination** in another area; each area's panel list → **Map all panels**.
- Settings search → a setting, collection editor, activity route or operation contract. Scheduling entries open Manage › Updates & schedules; onboarding entries open setup.
- **Assess & set up** from any page, which replaces the page with the setup wizard.
- Configuration, repair, update and schedule plans → apply → operation banner → receipt → History.
- The machine scope selector, which changes the data in every view.

### The first uncommitted attempt

An earlier uncommitted pass on this branch added a visit list. It was reworked before commit for four reasons:

- In-app Back delegated to `history.go()`. After a reload of the standalone preview, it navigated the frame away and the workbench disappeared.
- The list grew without limit. Once the saved state exceeded the host's 16 KiB budget, all saving stopped, including drafts.
- Scroll restoration called `window.scrollTo`, which does nothing inside the preview's content-sized frame.
- The five recent visits were hidden in a collapsed section.

## How the trail works

The trail is two bounded stacks and a pinned start.

- **A visit** is a place plus the detail open in the inspector. A place is the machine scope, area, tab, component or settings category, or the setup wizard. Typing, filtering and expanding sections update the current visit; they do not add one.
- **A new visit** pushes the current one onto **Back** and clears **Forward**. Back holds at most five visits; the oldest drops off.
- **Back and Forward** move one visit between the stacks. Choosing a trail entry moves several at once, and the skipped visits become Forward.
- **Start** reopens the first view of the session as a new visit, so Back still returns to where you were.
- **Close and Escape** pop a detail when the previous visit is the same place; otherwise they close it in place. They never change pages.
- **Clear trail** empties both stacks and makes the current view the new start. Remembered views and drafts stay.

| Step | Back, oldest first | Current | Forward, next first |
|---|---|---|---|
| Start in Settings | — | Settings | — |
| Choose Models, routing & budgets | Settings | Models | — |
| Open a search result | Settings, Models | Result detail | — |
| Go to Insights | Settings, Models, Result | Usage & cost | — |
| **Back** | Settings, Models | Result detail | Usage & cost |
| **Back** | Settings | Models | Result, Usage & cost |
| Open the panel map | Settings, Models | Panel map | — |

The bar above the scope selector shows Back, Forward and Start, the current location with its machine scope, and the trail of up to five earlier visits. Trail labels are abbreviated; each tooltip gives the full path. The bar also shows save status, **Clear trail** and **Reset demo…**, which asks for confirmation.

## What is remembered

| State | Remembered for | Cleared only by |
|---|---|---|
| Visit snapshot: place, open detail, that page's search and filters, expanded sections, last-used control | Each visit on the trail and the start | Clear trail, Reset demo state |
| Place memory: expanded sections and last-used control; each area's last tab | Every place visited; the 24 most recent are saved across reloads | Reset demo state |
| Settings search, category, component and entry-kind filters; panel-map search | Their page | Clear search, All categories, changing the filter, Reset demo state |
| Work: configuration drafts, staged collections, unsaved or invalid input, schedule draft, setup progress | Each machine scope | Discard draft, applying the plan, finishing setup, Reset demo state |
| Simulated results: applied values, receipts, operation status | The demo session | Reset demo state |
| Attention focus and density | The demo session | Changing them, Reset demo state |

Returning never runs anything again:

- A plan preview returns as **Previous preview · recheck required** with **Refresh this preview**, or as **Completed** with its receipt.
- A version check or assessment returns as a detail that needs fresh evidence.
- An operation that was running during a reload returns as **needs a status check**. It is not rerun.

## Where the memory lives

| Context | Storage | Position |
|---|---|---|
| Codex visualization host and the [standalone preview](previews/management-workbench.html) | Host widget state through `window.openai.setWidgetState`, limited to 16 KiB | Focus returns to the last-used control, which is scrolled into view; the host page scrolls |
| [report.html](report.html) and the [fragment](management-workbench.html) opened directly | Browser `localStorage` key `ak-v5-workbench-state`, same budget | Same |

- **Budget.** Saved visits are pooled and deduplicated. After more than 60 visits across three scopes, the saved state measured 3,373 bytes. If a save would exceed the budget, older place memories are dropped first, then Forward visits, then older Back visits. Drafts, results and the current view are never dropped; the status line reports a reduced or failed save.
- **No browser history.** The mockup does not use the History API. The in-app trail is the only source of truth, and the browser's Back button still leaves the page.
- **Position.** Back and Forward move focus to the last-used control and scroll it into view; re-entering an area only scrolls. A reload restores the view but leaves scrolling to the browser, so a page that embeds the workbench, such as the report, is not moved.
- **Earlier saves.** A state saved by an earlier revision contributes only its page, tab, scope, focus and settings filters.

## Recommendations for the product

1. **Make places addressable.** Put area, tab, component or category, scope and open detail in the URL, with search and filters as query parameters. Browser Back, reload and shared links then work natively, and the trail becomes a view over real history.
2. **Keep work in the control plane.** Store drafts, staged collections and setup progress per person and scope, with visible expiry and Discard. Browser storage is a presentation cache, not a system of record.
3. **Bind previews to revisions.** Returning to a plan must show whether it is stale. Applying requires a fresh preview.
4. **Keep resets explicit and few.** Each reset control says exactly what it clears.
5. **Manage focus.** Closing a detail returns focus to its opener, location changes are announced, and Escape closes the topmost detail.
6. **Validate the depth.** Five earlier visits is the requested default. Usability sessions should confirm whether operators need more, and whether fleet work needs a trail per scope.

## Verification and limits

A 64-check browser scenario suite passed in both the standalone preview and the report. The details are in [verification.md](verification.md#navigation-memory-revision--september-25).

This revision does not wire browser Back or Forward buttons or deep links. Saved memory stays in one browser profile and file location; it is not shared between people or devices. Position restore follows the last-used control and is not pixel-exact. The checks ran in Chromium only; no screen-reader study, usability study or WCAG certification is claimed.

[base]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html
[L145]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L145
[L153]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L153
[L164]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L164
[L165]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L165
[L185]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L185
[L278]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L278
[L279]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L279
[L280]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L280
[L281]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L281
[L282]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L282
[L284]: https://github.com/pacphi/agentic-kit/blob/b8e77f78dc3e69ec7a0e4712663bf378e1f7f82a/docs/research/v5/management-workbench.html#L284
