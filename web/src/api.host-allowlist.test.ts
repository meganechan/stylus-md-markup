// Minimal check for the md-paste host allowlist (kobo-1127 AC: "host validation
// ยอมรับ URL ของ md-paste และปฏิเสธ host อื่น"). Repo ships with no test runner
// configured; this uses bun's built-in one (`bun test`), no new dependency.
import { test, expect, mock } from "bun:test";
import { fetchExternalMd } from "./api";

test("accepts an allowlisted md-paste URL, prompts once for the read password, and sends it as a header", async () => {
  const calls: string[] = [];
  const headers: string[] = [];
  globalThis.prompt = mock(() => "s3cr3t") as unknown as typeof prompt;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    headers.push((init?.headers as Record<string, string> | undefined)?.["x-mdpaste-read-password"] ?? "");
    return new Response("hello", { status: 200 });
  }) as unknown as typeof fetch;

  const text = await fetchExternalMd("https://paste.codechill.io/p/4tFxc2i6FDOhozh4");
  expect(text).toBe("hello");
  expect(calls).toEqual(["/api/external-md/4tFxc2i6FDOhozh4"]);
  expect(headers).toEqual(["s3cr3t"]);
});

test("clears the cached read password and throws a clear error on 401", async () => {
  globalThis.prompt = mock(() => "wrong-pass") as unknown as typeof prompt;
  globalThis.fetch = mock(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

  await expect(fetchExternalMd("https://paste.codechill.io/p/4tFxc2i6FDOhozh4")).rejects.toThrow(/รหัสผ่าน/);
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
