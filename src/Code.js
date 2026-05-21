const CONFIG = {
  sheetName: 'jobs',
  defaultKeywords: [
    'GAS',
    'Google Apps Script',
    'スプレッドシート',
    'API連携',
    'ChatGPT',
    'Gemini',
  ],
};

const HEADERS = [
  'first_seen_at',
  'matched_at',
  'status',
  'title',
  'url',
  'matched_keywords',
  'source_url',
  'snippet',
];

function setup() {
  const sheet = getJobsSheet_();
  ensureHeader_(sheet);
}

function installTimeTrigger() {
  deleteTriggers_('checkNewJobs');
  ScriptApp.newTrigger('checkNewJobs').timeBased().everyHours(3).create();
}

function checkNewJobs() {
  const props = PropertiesService.getScriptProperties();
  const searchUrls = readJsonProperty_(props, 'SEARCH_URLS', []);

  if (!searchUrls.length) {
    throw new Error('Script Property SEARCH_URLS is required.');
  }

  const keywords = readJsonProperty_(props, 'KEYWORDS', CONFIG.defaultKeywords);
  const sheet = getJobsSheet_();
  ensureHeader_(sheet);

  const knownUrls = loadKnownUrls_(sheet);
  const newMatches = [];
  const now = new Date();

  searchUrls.forEach((sourceUrl) => {
    const html = fetchText_(sourceUrl);
    const candidates = extractJobCandidates_(html, sourceUrl);

    candidates.forEach((candidate) => {
      if (knownUrls.has(candidate.url)) return;

      const detailHtml = fetchText_(candidate.url);
      const title = extractTitle_(detailHtml) || candidate.title || candidate.url;
      const text = htmlToText_(detailHtml);
      const matchedKeywords = matchKeywords_(`${title}\n${text}`, keywords);
      const status = matchedKeywords.length ? 'matched' : 'seen';

      const row = [
        now,
        matchedKeywords.length ? now : '',
        status,
        title,
        candidate.url,
        matchedKeywords.join(', '),
        sourceUrl,
        makeSnippet_(text),
      ];

      sheet.appendRow(row);
      knownUrls.add(candidate.url);

      if (matchedKeywords.length) {
        newMatches.push({
          title,
          url: candidate.url,
          matchedKeywords,
          snippet: makeSnippet_(text),
        });
      }

      Utilities.sleep(1200);
    });
  });

  if (newMatches.length) {
    notify_(newMatches);
  }
}

function getJobsSheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('Script Property SPREADSHEET_ID is required.');
  }

  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  return spreadsheet.getSheetByName(CONFIG.sheetName) || spreadsheet.insertSheet(CONFIG.sheetName);
}

function ensureHeader_(sheet) {
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const hasHeader = HEADERS.every((header, index) => firstRow[index] === header);

  if (!hasHeader) {
    sheet.clear();
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
}

function loadKnownUrls_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const urls = sheet.getRange(2, 5, lastRow - 1, 1).getValues().flat();
  return new Set(urls.filter(Boolean));
}

function readJsonProperty_(props, key, fallback) {
  const value = props.getProperty(key);
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Script Property ${key} must be valid JSON: ${error.message}`);
  }
}

function fetchText_(url) {
  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 compatible; GAS job watcher',
    },
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error(`Fetch failed: ${status} ${url}`);
  }

  return response.getContentText('UTF-8');
}

function extractJobCandidates_(html, sourceUrl) {
  const base = sourceUrl.match(/^https?:\/\/[^/]+/)[0];
  const candidates = new Map();
  const linkPattern = /<a\b[^>]*href=["']([^"']*\/public\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const url = normalizeUrl_(match[1], base);
    const title = htmlToText_(match[2]);
    if (url) {
      candidates.set(url, { url, title });
    }
  }

  return Array.from(candidates.values());
}

function normalizeUrl_(href, base) {
  if (!href) return '';
  const cleanHref = href.replace(/&amp;/g, '&').split('#')[0];
  const url = cleanHref.startsWith('http') ? cleanHref : `${base}${cleanHref}`;
  return url.split('?')[0];
}

function extractTitle_(html) {
  const ogTitle = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (ogTitle) return decodeHtml_(ogTitle[1]).trim();

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? htmlToText_(title[1]).trim() : '';
}

function htmlToText_(html) {
  return decodeHtml_(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function decodeHtml_(text) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&([a-z]+);/gi, (_, name) => entities[name] || `&${name};`);
}

function matchKeywords_(text, keywords) {
  const normalizedText = text.toLowerCase();
  return keywords.filter((keyword) => normalizedText.includes(String(keyword).toLowerCase()));
}

function makeSnippet_(text) {
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

function notify_(matches) {
  const props = PropertiesService.getScriptProperties();
  const message = buildNotificationMessage_(matches);
  const webhookUrl = props.getProperty('CHAT_WEBHOOK_URL');
  const email = props.getProperty('NOTIFY_EMAIL');

  if (webhookUrl) {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: message }),
      muteHttpExceptions: true,
    });
  }

  if (email) {
    GmailApp.sendEmail(email, `CrowdWorks new matches: ${matches.length}`, message);
  }
}

function buildNotificationMessage_(matches) {
  const lines = [`CrowdWorksで新着候補が${matches.length}件見つかりました。`];

  matches.slice(0, 10).forEach((match, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${match.title}`);
    lines.push(`Keywords: ${match.matchedKeywords.join(', ')}`);
    lines.push(match.url);
    lines.push(match.snippet);
  });

  return lines.join('\n');
}

function deleteTriggers_(handlerName) {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handlerName)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

