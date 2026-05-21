# CrowdWorks GAS Job Watcher

CloudWorks search result pages are checked periodically with Google Apps Script.
New matching jobs are saved to Google Sheets and optionally sent to Google Chat
or email.

## What It Does

- Fetches configured CrowdWorks search URLs
- Extracts newly seen job URLs from search result pages
- Opens only new candidate detail pages
- Matches jobs by keywords such as GAS, Google Apps Script, spreadsheets, APIs,
  ChatGPT, and Gemini
- Stores results in a spreadsheet
- Notifies Google Chat and/or email
- Runs every 3 hours by time-based trigger

## Setup

1. Create a Google Spreadsheet for the database.
2. Create a new Apps Script project.
3. Copy `src/Code.js` and `src/appsscript.json` into the Apps Script project.
4. Open Apps Script project settings and set these Script Properties:

| Key | Required | Example |
| --- | --- | --- |
| `SPREADSHEET_ID` | Yes | `1abc...xyz` |
| `SEARCH_URLS` | Yes | `["https://crowdworks.jp/public/jobs/search?search%5Bkeywords%5D=GAS"]` |
| `KEYWORDS` | No | `["GAS","Google Apps Script","スプレッドシート","API連携","ChatGPT","Gemini"]` |
| `CHAT_WEBHOOK_URL` | No | `https://chat.googleapis.com/...` |
| `NOTIFY_EMAIL` | No | `you@example.com` |

5. Run `setup()` once from the Apps Script editor.
6. Run `installTimeTrigger()` once to schedule checks every 3 hours.

## Spreadsheet Columns

The script creates a `jobs` sheet with these columns:

- `first_seen_at`
- `matched_at`
- `status`
- `title`
- `url`
- `matched_keywords`
- `source_url`
- `snippet`

## Notes

This tool is intentionally conservative. It checks search result pages on a
3-hour interval and fetches detail pages only for URLs that have not been seen
before.
