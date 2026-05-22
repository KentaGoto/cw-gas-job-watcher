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
  ScriptApp.newTrigger('checkNewJobs').timeBased().everyHours(4).create();
}

function checkNewJobs() {
  const props = PropertiesService.getScriptProperties();
  const searchUrls = readJsonProperty_(props, 'SEARCH_URLS', []);

  if (!searchUrls.length) {
    throw new Error('Script Property SEARCH_URLS is required.');
  }

  Logger.log(`Checking ${searchUrls.length} search URL(s).`);

  const keywords = readJsonProperty_(props, 'KEYWORDS', CONFIG.defaultKeywords);
  const maxPages = readNumberProperty_(props, 'SEARCH_MAX_PAGES', 1);
  const sheet = getJobsSheet_();
  ensureHeader_(sheet);

  const knownUrls = loadKnownUrls_(sheet);
  const newMatches = [];
  const now = new Date();

  searchUrls.forEach((sourceUrl) => {
    for (let page = 1; page <= maxPages; page += 1) {
      const pageUrl = buildPageUrl_(sourceUrl, page);
      const html = fetchText_(pageUrl);
      const candidates = extractJobCandidates_(html, pageUrl);
      Logger.log(`${pageUrl}: found ${candidates.length} candidate URL(s).`);

      if (!candidates.length) break;

      candidates.forEach((candidate) => {
        if (isExpired_(candidate.expiredOn, now)) {
          Logger.log(`Expired: ${candidate.url}`);
          return;
        }

        if (knownUrls.has(candidate.url)) {
          Logger.log(`Already seen: ${candidate.url}`);
          return;
        }

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
          pageUrl,
          makeSnippet_(candidate.snippet || text),
        ];

        sheet.appendRow(row);
        knownUrls.add(candidate.url);

        if (matchedKeywords.length) {
          newMatches.push({
            title,
            url: candidate.url,
            matchedKeywords,
            snippet: makeSnippet_(candidate.snippet || text),
          });
        }

        Utilities.sleep(1200);
      });
    }
  });

  Logger.log(`Matched ${newMatches.length} new job(s).`);

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

function readNumberProperty_(props, key, fallback) {
  const value = props.getProperty(key);
  if (!value) return fallback;

  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`Script Property ${key} must be a positive number.`);
  }

  return Math.floor(number);
}

function buildPageUrl_(url, page) {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const cleaned = withoutHash
    .replace(/([?&])page=\d+(&?)/, (match, prefix, suffix) => (suffix ? prefix : ''))
    .replace(/[?&]$/, '');

  return `${cleaned}${separatorForUrl_(cleaned)}page=${page}${hash}`;
}

function separatorForUrl_(url) {
  return url.includes('?') ? '&' : '?';
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

  extractEmbeddedJobCandidates_(html, base).forEach((candidate) => {
    candidates.set(candidate.url, candidate);
  });

  const linkPattern = /<a\b[^>]*href=["']([^"']*\/public\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  const addCandidate = (href, title) => {
    const url = normalizeUrl_(href, base);
    if (url) {
      candidates.set(url, { url, title: title || '' });
    }
  };

  while ((match = linkPattern.exec(html)) !== null) {
    const title = htmlToText_(match[2]);
    addCandidate(match[1], title);
  }

  const hrefPattern = /href=["']([^"']*\/public\/jobs\/\d+[^"']*)["']/gi;
  while ((match = hrefPattern.exec(html)) !== null) {
    addCandidate(match[1], '');
  }

  return Array.from(candidates.values());
}

function extractEmbeddedJobCandidates_(html, base) {
  const match = html.match(/<div\b[^>]*id=["']vue-container["'][^>]*data=["']([^"']+)["']/i);
  if (!match) return [];

  try {
    const data = JSON.parse(decodeHtml_(match[1]));
    const jobOffers = data.searchResult && data.searchResult.job_offers;
    if (!Array.isArray(jobOffers)) return [];

    return jobOffers
      .map((item) => item.job_offer)
      .filter((job) => job && job.id)
      .map((job) => ({
        url: `${base}/public/jobs/${job.id}`,
        title: job.title || '',
        snippet: job.description_digest || '',
        expiredOn: job.expired_on || '',
      }));
  } catch (error) {
    Logger.log(`Failed to parse embedded job data: ${error.message}`);
    return [];
  }
}

function isExpired_(expiredOn, now) {
  if (!expiredOn) return false;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const parts = String(expiredOn).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return false;

  const expiredDate = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return expiredDate < today;
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
    MailApp.sendEmail(email, `CrowdWorks new matches: ${matches.length}`, message);
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
