# Tasks for Brightspace

A small, private browser extension that brings the useful part of **Tasks for Canvas** to Brightspace:

- a compact dashboard widget inserted above Announcements
- concentric weekly progress rings, colored by course
- upcoming work grouped into unfinished and completed lists
- automatic completion from Brightspace's own `DateCompleted` status
- manual checkboxes as a fallback
- previous/next week navigation
- strict due-date boundaries so tasks appear in only one week
- a course dropdown and clickable rings for filtering the task list
- animated ring progress, in-chart loading feedback, and task-list transitions
- collapsible Unfinished and Completed sections with animated chevrons
- right-column alignment against My Courses or Announcements
- animated whole-widget collapse and clearer checkbox-versus-link hover behavior
- incremental course-ring animation when a task is manually checked or unchecked
- no account, server, analytics, ads, or unrelated features

## Install it locally

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project folder—the folder containing `manifest.json`.
5. Open Brightspace and refresh the page.

The extension activates on URLs containing `/d2l/`. Use the arrow in its header to collapse or expand it like the other dashboard widgets.

## How completion works

The extension reads Brightspace's same-origin REST API using your existing signed-in browser session. It asks for:

1. your current course enrollments;
2. scheduled content for the visible week;
3. each item's `DateCompleted` value.

When Brightspace reports `DateCompleted`, the task moves to **Completed** automatically at the next refresh. The panel refreshes every five minutes and when you return to the tab. A manual check is stored only in `chrome.storage.local`; clicking a task still opens the real Brightspace activity.

## Important limitation

Brightspace only exposes items through the scheduled-content feed when an instructor added the activity to course Content and gave it a date. A quiz, assignment, discussion, or third-party activity that is not linked in Content may be absent. That is a Brightspace data-model limitation, not a permission the extension can work around safely.

If the panel says it cannot load tasks, open the browser developer console and look for a line beginning `Tasks for Brightspace:`. Different schools can disable API routes or use unusual roles; the error text will identify the next compatibility fix.

## Privacy and permissions

- `storage`: saves collapsed state and manual checkmarks.
- Brightspace page access: injects the panel and reads data from the Brightspace host you are already visiting.

Nothing is sent off the Brightspace site.

## Project structure

- `manifest.json` — Chrome/Edge Manifest V3 configuration
- `src/content.js` — Brightspace data adapter and panel behavior
- `src/panel.css` — isolated panel styles (Shadow DOM)

## Next compatibility step

This first build uses documented Brightspace APIs rather than scraping fragile page markup. Test it on your school's Brightspace dashboard. If a particular activity type is missing, capture the activity's title, type, and whether it appears in Brightspace's built-in **Work To Do** widget (do not share private course content). That will show whether it needs an additional quiz/assignment adapter or cannot be surfaced by the learner API.
