// Downloads the live API spec into spec/openapi.yaml, for test/spec.test.ts.
// Usage: npm run spec:update [-- <url>]
import { writeFile } from 'node:fs/promises';

const url = process.argv[2] ?? 'https://app.jamframe.com/openapi.yaml';
const res = await fetch(url);
if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
const text = await res.text();
if (!text.startsWith('openapi:')) throw new Error(`${url} is not an OpenAPI document`);
await writeFile(new URL('../spec/openapi.yaml', import.meta.url), text);
console.log(`spec/openapi.yaml updated from ${url} (${text.length} bytes)`);
