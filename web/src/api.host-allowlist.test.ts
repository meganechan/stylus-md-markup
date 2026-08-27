// Minimal check for the md-paste host allowlist (kobo-1127 AC: "host validation
// ยอมรับ URL ของ md-paste และปฏิเสธ host อื่น"). Repo ships with no test runner
// configured; this uses bun's built-in one (`bun test`), no new dependency.
import { test, expect, mock } from "bun:test";
import { fetchExternalMd } from "./api";

test("accepts an allowlisted md-paste URL and proxies through our own backend", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    calls.push(String(url));
    return new Response("hello", { status: 200 });
  }) as unknown as typeof fetch;

  const text = await fetchExternalMd("https://paste.codechill.io/p/4tFxc2i6FDOhozh4");
  expect(text).toBe("hello");
  expect(calls).toEqual(["/api/external-md/4tFxc2i6FDOhozh4"]);
});

test("rejects a non-allowlisted host (e.g. the old te-kb host)", async () => {
  globalThis.fetch = mock(async () => new Response("should not be called", { status: 200 })) as unknown as typeof fetch;
  await expect(fetchExternalMd("https://api.kb.notscam.space/p/abc12345?raw=1")).rejects.toThrow(/allowlist/);
});

test("rejects non-https", async () => {
  await expect(fetchExternalMd("http://paste.codechill.io/p/4tFxc2i6FDOhozh4")).rejects.toThrow(/https/);
});

test("rejects a malformed slug on an allowlisted host", async () => {
  await expect(fetchExternalMd("https://paste.codechill.io/p/short")).rejects.toThrow();
});
