import { createHash } from "node:crypto";

const APPLICATION_LINK = /(?:applicationDetails\.do|ApplicationSearchServlet|StdDetails\.aspx|PlanningPK\.xml|planning\/application)/i;
const USEFUL_DOCUMENT = /(?:\bplans?\b|drawing|layout|elevation|section|roof|landscap|planting|tree|arbor|material|finish|surface|path|plaza|ride|coaster|track|\bsupport(?:s| structure| layout| detail| foundation)?\b|structure|drain|water|flood|earthwork|level|topograph|survey|boundary|fence|wall|retaining|bridge|tunnel|as[ -]?built|existing)/i;
const NOISE_DOCUMENT = /(?:application form|planning statement|decision notice|screening opinion|letter of representation|ownership certificate|community infrastructure levy|cil form|consultation response|neighbour letter|site notice|press notice|fee|validation checklist|email|correspondence|committee agenda)/i;

export function extractHtmlLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const source = String(html || "");
  const patterns = [
    /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    /(?:window\.open|location(?:\.href)?)\s*\(?(?:\s*=\s*)?(["'])(.*?)\1\)?/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const href = decodeHtml(match[2] || "").trim();
      if (!href || /^(?:mailto:|tel:|#)/i.test(href)) continue;
      let url;
      const legacyBlob = href.match(/^javascript:AppBlobImage\(\s*['"]?([^'"\s;)]+)['"]?\s*\)/i);
      try {
        url = legacyBlob
          ? new URL(`AttachmentShowServlet?ImageName=${encodeURIComponent(legacyBlob[1])}`, baseUrl).toString()
          : new URL(href, baseUrl).toString();
      } catch { continue; }
      if (!/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      links.push({ url, text: cleanText(match[3] || href) });
    }
  }
  return links;
}

export function extractApplicationLinks(html, baseUrl, allowedHosts = []) {
  const allowed = allowedHostSet(baseUrl, allowedHosts);
  return extractHtmlLinks(html, baseUrl)
    .filter((link) => allowed.has(new URL(link.url).hostname.toLowerCase()))
    .filter((link) => APPLICATION_LINK.test(link.url));
}

export function extractDocumentLinks(html, baseUrl, allowedHosts = []) {
  const allowed = allowedHostSet(baseUrl, allowedHosts);
  return [...extractHtmlLinks(html, baseUrl), ...extractNecPublicAccessDocuments(html, baseUrl)]
    .filter((link) => allowed.has(new URL(link.url).hostname.toLowerCase()))
    .filter((link) => isDirectDocumentLink(link.url))
    .map((link) => ({ ...link, ...classifyPlanningDocument(link.text, link.url) }))
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

function extractNecPublicAccessDocuments(html, baseUrl) {
  const modelText = String(html || "").match(/\bvar\s+model\s*=\s*(\{[\s\S]*?\});/)?.[1];
  if (!modelText) return [];
  try {
    const model = JSON.parse(modelText);
    return (model.Rows || []).flatMap((row) => {
      const guid = String(row.Guid || "").trim();
      if (!/^[a-f0-9]{20,}$/i.test(guid)) return [];
      const title = cleanText([row.Doc_Type, row.Doc_Ref2].filter(Boolean).join(" - "));
      return [{
        url: new URL(`/PublicAccess_Live/Document/ViewDocument?id=${encodeURIComponent(guid)}`, baseUrl).toString(),
        text: title || "Planning document"
      }];
    });
  } catch {
    return [];
  }
}

function isDirectDocumentLink(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (/\.(?:pdf|tiff?|png|jpe?g|zip)(?:$|[?#])/i.test(url.pathname)) return true;
  if (/(?:AttachmentShowServlet|ViewDocument|DownloadFile|download|attachment|viewfile|image)/i.test(url.pathname)) return true;
  return false;
}

function allowedHostSet(baseUrl, allowedHosts) {
  return new Set([new URL(baseUrl).hostname, ...allowedHosts].map((value) => String(value).toLowerCase()));
}

export function extractDocumentPageLinks(html, baseUrl, allowedHosts = []) {
  const allowed = allowedHostSet(baseUrl, allowedHosts);
  return extractHtmlLinks(html, baseUrl)
    .filter((link) => allowed.has(new URL(link.url).hostname.toLowerCase()))
    .filter((link) =>
      /(?:activeTab=documents|\bdocuments?\b|DocList|AssociatedFiles)/i.test(`${link.url} ${link.text}`)
    );
}

export function parsePlanningApplicationPage(html, url) {
  const text = cleanText(html);
  const tableFields = extractTableFields(html);
  const field = (...labels) => {
    for (const label of labels) {
      const exact = tableFields.get(cleanText(label).toLowerCase());
      if (exact) return exact;
      const escaped = escapeRegExp(label);
      const patterns = [
        new RegExp(`${escaped}\\s*(?:<\\/[^>]+>\\s*)*(?:<[^>]+>\\s*)*([^<]{1,500})`, "i"),
        new RegExp(`${escaped}\\s*[:\\-]?\\s*([^\\n\\r]{1,500})`, "i")
      ];
      for (const pattern of patterns) {
        const value = cleanText(String(html).match(pattern)?.[1] || text.match(pattern)?.[1] || "");
        if (value && !new RegExp(`^${escaped}$`, "i").test(value)) return value;
      }
    }
    return null;
  };
  const reference = field("Application number", "Application reference", "Reference", "Ref No") || referenceFromUrl(url);
  return {
    reference,
    address: field("Site address", "Location", "Address"),
    proposal: field("Proposal", "Description", "Development description"),
    status: field("Application status", "Status", "Decision"),
    decision: field("Decision", "Decision type"),
    decisionDate: normalizeDate(field("Decision date", "Decision issued date")),
    easting: numberField(field("Easting", "X coordinate")),
    northing: numberField(field("Northing", "Y coordinate")),
    sourceUrl: url
  };
}

function extractTableFields(html) {
  const fields = new Map();
  const rows = String(html || "").match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map((match) => cleanText(match[1]))
      .filter(Boolean);
    for (let index = 0; index + 1 < cells.length; index += 2) {
      const label = cells[index].replace(/\s*[:\-]\s*$/, "").toLowerCase();
      if (label && !fields.has(label)) fields.set(label, cells[index + 1]);
    }
  }
  return fields;
}

export function classifyPlanningDocument(title, url = "") {
  const value = cleanText(`${title || ""} ${decodeURIComponentSafe(url)}`);
  let role = "planning-document";
  if (/as[ -]?built|record drawing|completion plan/i.test(value)) role = "as-built-drawing";
  else if (/ride|coaster|track|\bsupport(?:s| structure| layout| detail| foundation)?\b|foundation|footing/i.test(value)) role = "ride-layout-and-structure";
  else if (/site.*(?:plan|layout)|masterplan|general arrangement|proposed layout/i.test(value)) role = "site-layout";
  else if (/elevation|section|roof|level/i.test(value)) role = "elevations-and-sections";
  else if (/landscap|planting|tree|arbor|hedge|ecolog/i.test(value)) role = "landscape-and-vegetation";
  else if (/material|finish|surface|paving|path|plaza|hardscape/i.test(value)) role = "materials-and-surfaces";
  else if (/water|drain|flood|pond|lake/i.test(value)) role = "water-and-drainage";
  else if (/wall|fence|barrier|bridge|tunnel|earthwork|retaining/i.test(value)) role = "structures-and-earthworks";
  const useful = USEFUL_DOCUMENT.test(value) || /\.(?:pdf|tiff?|png|jpe?g|zip)(?:$|[?#])/i.test(url);
  const noise = NOISE_DOCUMENT.test(value);
  let score = useful ? 45 : 5;
  if (/approved|decision|condition|as[ -]?built|existing/i.test(value)) score += 25;
  if (/general arrangement|site plan|layout|elevation|section/i.test(value)) score += 20;
  if (/ride|coaster|track|\bsupport(?:s| structure| layout| detail| foundation)?\b/i.test(value)) score += 20;
  if (noise) score -= 80;
  return { role, score, relevant: score >= 30, title: cleanText(title || role) };
}

export function scorePlanningApplication(application, profile) {
  const haystack = cleanText([
    application.reference, application.address, application.proposal,
    application.description, application.status, application.decision
  ].filter(Boolean).join(" ")).toLowerCase();
  let score = Number(application.discoveryScore || 0);
  const terms = profile?.planningAuthority?.searchTerms || [];
  for (const term of terms) {
    const normalized = cleanText(term).toLowerCase();
    if (!normalized) continue;
    if (haystack.includes(normalized)) score += normalized.includes(" ") ? 40 : 20;
    const tokens = normalized.split(/\s+/).filter((token) => token.length >= 4);
    score += tokens.filter((token) => haystack.includes(token)).length * 4;
  }
  if (/theme park|amusement|roller\s*coaster|ride|attraction/i.test(haystack)) score += 15;
  if (/withdrawn|refused|invalid|demolish(?:ed|ion)?|superseded/i.test(haystack)) score -= 8;
  return score;
}

export function applicationIdentity(application) {
  const reference = cleanText(application.reference || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (reference) return `ref:${reference}`;
  const url = String(application.sourceUrl || application.url || "");
  if (url) {
    try {
      const parsed = new URL(url);
      for (const key of ["keyVal", "PKID", "PARAM0"]) {
        const value = parsed.searchParams.get(key);
        if (value) return `portal:${parsed.hostname.toLowerCase()}:${key.toLowerCase()}:${value.toLowerCase()}`;
      }
    } catch {}
    return `url:${url}`;
  }
  return `hash:${createHash("sha256").update(JSON.stringify(application)).digest("hex").slice(0, 20)}`;
}

export function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));
}

export function cleanText(value) {
  return decodeHtml(String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function referenceFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("reference") || parsed.searchParams.get("PKID") || parsed.searchParams.get("PARAM0") || null;
  } catch { return null; }
}

function normalizeDate(value) {
  if (!value) return null;
  const match = String(value).match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  const direct = Date.parse(value);
  return Number.isFinite(direct) ? new Date(direct).toISOString().slice(0, 10) : null;
}

function numberField(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(String(value || "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(number) ? number : null;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
