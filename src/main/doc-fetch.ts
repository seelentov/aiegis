import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import net from 'node:net';
import zlib from 'node:zlib';
import { Parser } from 'htmlparser2';

/** Downloading of document sources for the refresher (SPEC §24): runs in the app, the agent only asks for URLs. */

export interface FetchSettings {
  max_bytes: number;
  timeout_sec: number;
  max_redirects: number;
  user_agent: string;
  allow_private_addresses: boolean;
}

export interface FetchRules {
  /** Hosts a request may start at and must end at. */
  allowedHosts: string[];
  /** Allowed hosts whose certificate is not verified: set by a human on a link. */
  insecureHosts: string[];
}

export interface Fetched {
  finalUrl: string;
  contentType: string;
  body: Buffer;
  /** Plain HTTP or an unverified certificate: anyone on the path could have changed the content. */
  unverifiedChannel: boolean;
}

const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(a, p, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  return family !== 0 && BLOCKED.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/** Resolves a name and refuses private addresses at connect time, so a DNS answer cannot change after a check. */
const publicLookup: LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (cb as (e: Error) => void)(err);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) return (cb as (e: Error) => void)(new Error(`${hostname} resolves to a private address ${bad.address}`));
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
};

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  setCookie: string[];
  body: Buffer;
}

function requestOnce(url: URL, rules: FetchRules, s: FetchSettings, cookie: string, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const host = hostOf(url.href);
    if (!s.allow_private_addresses && isPrivateAddress(host)) return reject(new Error(`${host} is a private address`));
    const headers: Record<string, string> = { 'user-agent': s.user_agent, accept: '*/*', 'accept-encoding': 'gzip, deflate, br' };
    if (cookie) headers.cookie = cookie;
    const common = { method: 'GET', headers, signal, ...(s.allow_private_addresses ? {} : { lookup: publicLookup }) };
    const req =
      url.protocol === 'https:'
        ? https.request(url, { ...common, rejectUnauthorized: !rules.insecureHosts.includes(host) })
        : http.request(url, common);
    req.on('error', reject);
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const location = status >= 300 && status < 400 ? res.headers.location : undefined;
      const hop = { status, location, contentType: res.headers['content-type'] ?? '', setCookie: res.headers['set-cookie'] ?? [] };
      // A body is read only from an allowed host: what passes through other hosts stays out of the app.
      if (location || !rules.allowedHosts.includes(host)) {
        res.destroy();
        return resolve({ ...hop, body: Buffer.alloc(0) });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > s.max_bytes) {
          reject(new Error(`the response is larger than ${s.max_bytes} bytes`));
          return req.destroy();
        }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ ...hop, body: decompress(Buffer.concat(chunks), String(res.headers['content-encoding'] ?? ''), s.max_bytes) });
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.end();
  });
}

function decompress(body: Buffer, encoding: string, max: number): Buffer {
  const o = { maxOutputLength: max };
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(body, o);
  if (encoding === 'deflate') return zlib.inflateSync(body, o);
  if (encoding === 'br') return zlib.brotliDecompressSync(body, o);
  return body;
}

/**
 * GET with the refresher's rules: only http(s); starts at an allowed host; other public hosts may appear in the middle
 * of a redirect chain (single sign-on) but the chain must end at an allowed host; cookies live for this request only.
 */
export async function fetchSource(start: string, rules: FetchRules, s: FetchSettings): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new Error(`invalid URL ${start}`);
  }
  const check = (u: URL) => {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http and https are allowed: ${u.href}`);
  };
  check(url);
  if (!rules.allowedHosts.includes(hostOf(url.href))) throw new Error(`host ${hostOf(url.href)} is not among the links of this check; allowed: ${rules.allowedHosts.join(', ')}`);
  const signal = AbortSignal.timeout(s.timeout_sec * 1000);
  // shortcut: cookies are kept per exact host and Domain/Path are ignored; enough for sign-on hops, upgrade if a site needs more.
  const cookies = new Map<string, Map<string, string>>();
  for (let hops = 0; ; hops++) {
    const host = hostOf(url.href);
    const jar = cookies.get(host) ?? new Map<string, string>();
    cookies.set(host, jar);
    const hop = await requestOnce(url, rules, s, [...jar].map(([k, v]) => `${k}=${v}`).join('; '), signal);
    for (const c of hop.setCookie) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (hop.location) {
      if (hops >= s.max_redirects) throw new Error(`more than ${s.max_redirects} redirects from ${start}`);
      url = new URL(hop.location, url);
      check(url);
      continue;
    }
    if (!rules.allowedHosts.includes(host)) throw new Error(`the redirect from ${start} ended at ${url.href}, whose host is not among the links of this check`);
    if (hop.status < 200 || hop.status >= 300) throw new Error(`HTTP ${hop.status} at ${url.href}`);
    return {
      finalUrl: url.href,
      contentType: hop.contentType,
      body: hop.body,
      unverifiedChannel: url.protocol === 'http:' || rules.insecureHosts.includes(host),
    };
  }
}

export function isHtml(f: Pick<Fetched, 'contentType' | 'body'>): boolean {
  if (/html|xml/i.test(f.contentType)) return true;
  return !f.contentType && /^\s*<(!doctype html|html)/i.test(f.body.subarray(0, 256).toString('latin1'));
}

export function isPlainText(contentType: string): boolean {
  return /^text\/(plain|markdown)/i.test(contentType);
}

/** Decodes by the declared charset: the header first, then the page's own meta tag. Russian sites still use windows-1251. */
export function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'header', 'footer', 'aside']);
const BLOCK = new Set(['p', 'div', 'br', 'hr', 'li', 'tr', 'table', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'ul', 'ol', 'dl', 'dt', 'dd']);

export interface PageText {
  title: string;
  text: string;
  links: { url: string; text: string }[];
}

/** Text of an HTML page without scripts and site furniture, one block per line; table cells are joined with " | ". */
export function htmlToText(html: string, baseUrl: string): PageText {
  let out = '';
  let skip = 0;
  let title = '';
  let inTitle = false;
  const links: { url: string; text: string }[] = [];
  let link: { url: string; text: string } | null = null;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'title') inTitle = true;
        if (SKIPPED.has(name)) skip++;
        if (BLOCK.has(name)) out += '\n';
        if (name === 'td' || name === 'th') out += ' | ';
        if (name === 'a' && attrs.href && !skip) {
          try {
            link = { url: new URL(attrs.href, baseUrl).href, text: '' };
          } catch {
            // not a URL: left out of the link list
          }
        }
      },
      ontext(t) {
        if (inTitle) title += t;
        else if (!skip) {
          out += t;
          if (link) link.text += t;
        }
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false;
        if (SKIPPED.has(name)) skip = Math.max(0, skip - 1);
        if (BLOCK.has(name)) out += '\n';
        if (name === 'a' && link) {
          links.push({ url: link.url, text: link.text.replace(/\s+/g, ' ').trim() });
          link = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  const text = out
    .split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').replace(/^( ?\| ?)+/, '').trim())
    .filter(Boolean)
    .join('\n');
  return { title: title.replace(/\s+/g, ' ').trim(), text, links };
}

/** The part of a page between two phrases of the agent, inclusive. Line breaks in a phrase match any whitespace. */
export function cropText(text: string, start: string, end: string): string {
  const pattern = (p: string) => new RegExp(p.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  const from = pattern(start).exec(text);
  if (!from) throw new Error(`the start phrase is not on the page: "${start}"`);
  let to: RegExpExecArray | null = null;
  const re = pattern(end);
  re.lastIndex = from.index;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    to = m;
    if (!m[0].length) break;
  }
  if (!to) throw new Error(`the end phrase is not on the page after the start phrase: "${end}"`);
  return text.slice(from.index, to.index + to[0].length);
}

const normLine = (l: string) => l.toLowerCase().replace(/[\s ]+/g, ' ').trim();
const linesOf = (t: string) => t.split('\n').map(normLine).filter(Boolean);

/** Share of the paragraphs of `text` found word for word in `page`: guards a text the agent rewrote by itself. */
export function coverage(text: string, page: string): number {
  const lines = linesOf(text);
  if (!lines.length) return 0;
  const hay = normLine(page.replace(/\n/g, ' '));
  return lines.filter((l) => hay.includes(l)).length / lines.length;
}

/** Whether a new text brings nothing: no new paragraph and at most `maxRemoved` gone (a line like a saved file's header). */
export function sameText(next: string, current: string, maxRemoved: number): boolean {
  const curHay = normLine(current.replace(/\n/g, ' '));
  if (linesOf(next).some((l) => !curHay.includes(l))) return false;
  const nextHay = normLine(next.replace(/\n/g, ' '));
  return linesOf(current).filter((l) => !nextHay.includes(l)).length <= maxRemoved;
}
