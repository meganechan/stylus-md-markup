// Render a Document into a beautified Preview (our own render — not borrowed).
// markdown-it + highlight.js, plus image-src rewriting so a Document's local
// images resolve through the backend's /static mount.

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: false, // the source is someone else's .md — don't trust raw HTML
  linkify: true,
  typographer: true,
  highlight(code, lang): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through */
      }
    }
    return hljs.highlightAuto(code).value;
  },
});

// Rewrite relative image paths to /static/<docDir>/<src> so local images load.
// Absolute URLs (http/https, data:, /static already) are left untouched.
function rewriteImages(html: string, docDir: string): string {
  return html.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (tag, src: string) => {
    if (/^(https?:|data:|\/static\/)/i.test(src)) return tag;
    const clean = src.replace(/^\.\//, "");
    const joined = docDir && docDir !== "." ? `${docDir}/${clean}` : clean;
    const rewritten = `/static/${joined.split("/").map(encodeURIComponent).join("/")}`;
    return tag.replace(`src="${src}"`, `src="${rewritten}"`);
  });
}

export function renderMarkdown(text: string, docDir: string): string {
  return rewriteImages(md.render(text), docDir);
}
