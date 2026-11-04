import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coverage, cropText, decodeBody, fetchSource, htmlToText, isPrivateAddress, sameText, type FetchSettings } from '../src/main/doc-fetch';

const settings: FetchSettings = { max_bytes: 1000, timeout_sec: 5, max_redirects: 3, user_agent: 'test', allow_private_addresses: true };

let server: http.Server;
let base: string;
const seenCookies: (string | undefined)[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenCookies.push(req.headers.cookie);
    if (req.url === '/page') return res.end('<html>ok</html>');
    if (req.url === '/huge') return res.end('x'.repeat(5000));
    if (req.url === '/gz') {
      res.setHeader('content-encoding', 'gzip');
      return res.end(zlib.gzipSync('compressed'));
    }
    if (req.url === '/sso') {
      res.statusCode = 302;
      res.setHeader('set-cookie', 'sid=1; Path=/');
      res.setHeader('location', '/back');
      return res.end();
    }
    if (req.url === '/back') return res.end(req.headers.cookie === 'sid=1' ? 'signed in' : 'no cookie');
    if (req.url === '/loop') {
      res.statusCode = 302;
      res.setHeader('location', '/loop');
      return res.end();
    }
    if (req.url === '/elsewhere') {
      res.statusCode = 302;
      res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/page`);
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const rules = { allowedHosts: ['127.0.0.1'], insecureHosts: [] };

describe('fetchSource', () => {
  it('allows only the hosts of the check', async () => {
    await expect(fetchSource(`${base}/page`, { allowedHosts: ['example.org'], insecureHosts: [] }, settings)).rejects.toThrow(/not among the links/);
    expect((await fetchSource(`${base}/page`, rules, settings)).body.toString()).toContain('ok');
  });

  it('refuses other schemes', async () => {
    await expect(fetchSource('file:///etc/passwd', { allowedHosts: [''], insecureHosts: [] }, settings)).rejects.toThrow(/only http and https/);
    await expect(fetchSource('not a url', rules, settings)).rejects.toThrow(/invalid URL/);
  });

  it('refuses private addresses, as a literal and through DNS', async () => {
    const strict = { ...settings, allow_private_addresses: false };
    await expect(fetchSource(`${base}/page`, rules, strict)).rejects.toThrow(/private address/);
    await expect(fetchSource('http://localhost/', { allowedHosts: ['localhost'], insecureHosts: [] }, strict)).rejects.toThrow(/private address/);
  });

  it('marks plain http as an unverified channel', async () => {
    expect((await fetchSource(`${base}/page`, rules, settings)).unverifiedChannel).toBe(true);
  });

  it('keeps cookies within one request through a redirect', async () => {
    expect((await fetchSource(`${base}/sso`, rules, settings)).body.toString()).toBe('signed in');
    seenCookies.length = 0;
    await fetchSource(`${base}/page`, rules, settings);
    expect(seenCookies).toEqual([undefined]);
  });

  it('passes other hosts in the middle but demands an allowed host at the end', async () => {
    await expect(fetchSource(`${base}/elsewhere`, rules, settings)).rejects.toThrow(/ended at .*localhost.*not among the links/);
    const both = { allowedHosts: ['127.0.0.1', 'localhost'], insecureHosts: [] };
    expect((await fetchSource(`${base}/elsewhere`, both, settings)).finalUrl).toContain('localhost');
  });

  it('limits redirects and size, decompresses, reports HTTP errors', async () => {
    await expect(fetchSource(`${base}/loop`, rules, settings)).rejects.toThrow(/more than 3 redirects/);
    await expect(fetchSource(`${base}/huge`, rules, settings)).rejects.toThrow(/larger than 1000 bytes/);
    expect((await fetchSource(`${base}/gz`, rules, settings)).body.toString()).toBe('compressed');
    await expect(fetchSource(`${base}/missing`, rules, settings)).rejects.toThrow(/HTTP 404/);
  });
});

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1'])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '95.173.128.1', '2a00:1450:4001::1', 'example.org'])('%s is not', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('page text', () => {
  const page = `<html><head><title> Order  55 </title><script>var a = "menu";</script></head><body>
    <nav><a href="/skip">Site menu</a></nav><header>Site header</header>
    <h1>Order 55</h1><p>First&nbsp;clause.</p>
    <table><tr><td>Cell A</td><td>Cell B</td></tr></table>
    <p><a href="/next.pdf">Next edition</a></p><footer>Footer ad</footer></body></html>`;

  it('keeps the document and drops the site furniture', () => {
    const r = htmlToText(page, 'https://site.example/doc/');
    expect(r.title).toBe('Order 55');
    expect(r.text.split('\n')).toEqual(['Order 55', 'First clause.', 'Cell A | Cell B', 'Next edition']);
    expect(r.links).toEqual([{ url: 'https://site.example/next.pdf', text: 'Next edition' }]);
  });

  it('decodes the declared charset', () => {
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xea, 0xe0, 0xe7]);
    expect(decodeBody(cp1251, 'text/html; charset=windows-1251')).toBe('Приказ');
    expect(decodeBody(Buffer.concat([Buffer.from('<meta charset="windows-1251">'), cp1251]), 'text/html')).toContain('Приказ');
  });

  it('crops between two phrases, line breaks matching any whitespace', () => {
    const t = 'menu\nORDER of the\nservice\nbody\nend of it\nads';
    expect(cropText(t, 'ORDER of the service', 'end of it')).toBe('ORDER of the\nservice\nbody\nend of it');
    expect(() => cropText(t, 'absent', 'end of it')).toThrow(/start phrase/);
    expect(() => cropText(t, 'body', 'menu')).toThrow(/end phrase/);
  });

  it('coverage counts paragraphs found on the page', () => {
    expect(coverage('one line\ntwo line', 'x one line y\ntwo line')).toBe(1);
    expect(coverage('one line\nmade up', 'one line')).toBe(0.5);
    expect(coverage('', 'page')).toBe(0);
  });

  it('a text is the same only if it adds nothing and removes almost nothing', () => {
    const current = 'Source: saved copy\nClause one.\nClause two.';
    expect(sameText('Clause one.\nClause two.', current, 1)).toBe(true);
    expect(sameText('Clause one.\nClause two changed.', current, 1)).toBe(false);
    expect(sameText('Clause one.\nClause two.\nClause three.', current, 1)).toBe(false);
    expect(sameText('Clause one.', current, 1)).toBe(false);
  });
});
