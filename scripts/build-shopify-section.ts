/**
 * Generate the Shopify theme section from the analyser page.
 *
 *   npm run build:section
 *
 * `public/analyzer/index.html` stays the single source. The section is output,
 * never edited by hand: the whole reason the earlier iframe plan existed was
 * to avoid maintaining two copies of this page, and a generator removes that
 * objection without the three postMessage bridges a frame needed.
 *
 * What the transform has to do, and why:
 *
 *   Scope every selector. The theme's base.css already defines .btn,
 *   .btn-primary, .btn-ghost, .opt, .eyebrow, .row, .sub, .total, .wrap,
 *   .item, .meter and .live — around fifty rules on the exact classes this
 *   page's layout is built from. Unscoped, the two stylesheets fight and the
 *   page breaks in ways that depend on load order. Everything is therefore
 *   nested under #qsc-app, and :root / html / body all become #qsc-app so the
 *   custom properties and base typography still land.
 *
 *   Prefix keyframes. Animation names are global; `fade` and `pulse` are
 *   exactly the names a theme is likely to have taken already.
 *
 *   Absolute API. Served from the storefront, a relative /api/skin would hit
 *   Shopify. It becomes the Vercel origin, which is why
 *   SHOPIFY_STOREFRONT_ORIGIN has to list the storefront domains.
 *
 *   Images move to theme assets, so they are served from Shopify's CDN rather
 *   than cross-origin from Vercel.
 *
 *   Drop the page's own header and footer. The theme supplies both.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import postcss, { type Rule, type AtRule } from 'postcss';

const SRC = resolve('public/analyzer/index.html');
const OUT = resolve('shopify/sections/skin-consultation.liquid');
const SCOPE = '#qsc-app';
const KEYFRAME_PREFIX = 'qsc-';
const API_ORIGIN = process.env.ANALYSER_API_ORIGIN ?? 'https://quality-skincare-analyzer.vercel.app';

const html = readFileSync(SRC, 'utf8');

// ── slice the source apart ───────────────────────────────────────────────────

function between(open: string, close: string, from = 0): { body: string; start: number; end: number } {
  const a = html.indexOf(open, from);
  const b = html.indexOf(close, a + open.length);
  if (a < 0 || b < 0) throw new Error(`could not find ${open} … ${close}`);
  return { body: html.slice(a + open.length, b), start: a, end: b + close.length };
}

const css = between('<style>', '</style>').body;

/**
 * A region of the document from one marker up to (not including) another.
 * Unlike `between`, the opening marker is kept, because dropping it is how
 * you end up emitting an orphan `</div>` that silently closes the wrapper and
 * drops everything after it out of scope.
 */
function region(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not find region ${from} … ${to}`);
  return html.slice(a, b);
}

/** Tag balance is the invariant that keeps the wrapper closed in the right place. */
function assertBalanced(label: string, fragment: string): string {
  const opens = (fragment.match(/<div\b/g) ?? []).length;
  const closes = (fragment.match(/<\/div>/g) ?? []).length;
  if (opens !== closes)
    throw new Error(`${label}: ${opens} <div> vs ${closes} </div> — unbalanced fragment`);
  return fragment;
}

const mainInner = assertBalanced('main', between('<main class="shell">', '</main>').body);
const trustBlock = assertBalanced('trust', region('<div class="trust">', '<footer class="foot">'));
const feedbackBlock = assertBalanced('feedback', region('<div class="fb-wrap"', '<div class="toast"'));
const toastAndLive = assertBalanced('toast+live', region('<div class="toast"', '\n\n<script>'));

// The main script is the last <script> block.
const lastScriptOpen = html.lastIndexOf('<script>');
const script = html.slice(lastScriptOpen + '<script>'.length, html.lastIndexOf('</script>'));

// ── CSS: scope it ────────────────────────────────────────────────────────────

const keyframeNames = new Set<string>();
const root = postcss.parse(css);

root.walkAtRules(at => {
  if (/^(-\w+-)?keyframes$/.test(at.name)) keyframeNames.add(at.params.trim());
});

function scopeSelector(sel: string): string {
  const s = sel.trim();

  // The page is the root now, so whatever targeted the document targets it.
  if (s === ':root' || s === 'html' || s === 'body' || s === 'html, body') return SCOPE;

  // `html.embed …` only exists for the iframe build. Natively there is no
  // frame, so these rules are dropped rather than translated.
  if (s.startsWith('html.embed')) return '';

  // Leading html/body qualifiers fold into the scope.
  const stripped = s.replace(/^(html|body)\s+/, '');
  if (stripped.startsWith(SCOPE)) return stripped;
  return `${SCOPE} ${stripped}`;
}

root.walkRules((rule: Rule) => {
  // Selectors inside @keyframes are percentages, not element selectors.
  const parent = rule.parent as AtRule | undefined;
  if (parent && parent.type === 'atrule' && /keyframes$/.test(parent.name)) return;

  const out = rule.selectors.map(scopeSelector).filter(Boolean);
  if (out.length === 0) rule.remove();
  else rule.selectors = out;
});

// Animation names are global; prefix the definitions and every reference.
root.walkAtRules(at => {
  if (/^(-\w+-)?keyframes$/.test(at.name)) at.params = KEYFRAME_PREFIX + at.params.trim();
});
root.walkDecls(decl => {
  if (!/^(-\w+-)?animation(-name)?$/.test(decl.prop)) return;
  for (const name of keyframeNames) {
    decl.value = decl.value.replace(new RegExp(`(^|[\\s,])${name}([\\s,]|$)`, 'g'),
      (_m, a, b) => `${a}${KEYFRAME_PREFIX}${name}${b}`);
  }
});

const scopedCss = root.toString();

// ── markup ───────────────────────────────────────────────────────────────────

// Images move to theme assets. The markup references become asset_url, and the
// JS catalog gets a Liquid-built map rather than relative paths.
const assetNames = new Set<string>();
const rewriteImgs = (s: string) =>
  s.replace(/(src|href)="assets\/([^"]+)"/g, (_m, attr, file) => {
    assetNames.add(file);
    return `${attr}="{{ '${file}' | asset_url }}"`;
  });

const markup = assertBalanced('markup', [
  mainInner, trustBlock, feedbackBlock, toastAndLive,
].map(rewriteImgs).join('\n'));

// ── script ───────────────────────────────────────────────────────────────────

let js = script;

function replaceOnce(from: string | RegExp, to: string, label: string) {
  const before = js;
  js = js.replace(from, to);
  if (js === before) throw new Error(`script transform missed: ${label}`);
}

// Same-origin on Vercel, cross-origin here.
replaceOnce('const API = "/api/skin";',
  `const API = ${JSON.stringify(API_ORIGIN + '/api/skin')};`, 'API origin');

// Product images come from the theme's assets, injected by Liquid above.
replaceOnce(/img:"assets\/([^"]+)"/g, 'img:QSC_ASSETS["$1"]', 'catalog images');
for (const m of script.matchAll(/img:"assets\/([^"]+)"/g)) assetNames.add(m[1]);

// The iframe bridges are dead weight on a native page: /cart/add.js is now
// same-origin, and position:fixed works because the page owns the viewport.
replaceOnce(/const EMBEDDED = window\.self !== window\.top;/, 'const EMBEDDED = false;', 'embed flag');

// "Buy this routine" takes them to the cart rather than leaving them on the page.
replaceOnce(
  `$("#addAll").addEventListener("click", () => {
  if (!S.result) return;
  addToCart(S.result.routine.filter(i => CATALOG[i.sku] && CATALOG[i.sku].inStock !== false).map(i => i.sku), "Routine added to bag");
});`,
  `$("#addAll").addEventListener("click", async () => {
  if (!S.result) return;
  const skus = S.result.routine.filter(i => CATALOG[i.sku] && CATALOG[i.sku].inStock !== false).map(i => i.sku);
  /* Straight to the cart on success. On failure stay put and say so, rather
     than navigating to a cart that does not contain what was just promised. */
  if (await addToCart(skus, "Routine added to bag")) window.location.href = QSC_CART_URL;
});`, 'buy this routine');

// addToCart must report success for the redirect above to be safe.
replaceOnce(`  toast(ok ? msg : msg + " (preview)");
  scheduleFeedback("RECOMMEND", FEEDBACK_AFTER_CART_MS);
}`,
`  toast(ok ? msg : msg + " (could not add, please try again)");
  scheduleFeedback("RECOMMEND", FEEDBACK_AFTER_CART_MS);
  return ok;
}`, 'addToCart return');

// ── emit ─────────────────────────────────────────────────────────────────────

const assets = [...assetNames].sort();

const liquid = `{%- comment -%}
  GENERATED FILE — do not edit.
  Source: public/analyzer/index.html
  Rebuild: npm run build:section

  Every selector below is scoped to ${SCOPE} because the theme's base.css
  already defines .btn, .opt, .eyebrow, .row, .sub, .total, .wrap, .item,
  .meter and .live. Keyframes are prefixed "${KEYFRAME_PREFIX}" for the same reason.

  Requires SHOPIFY_STOREFRONT_ORIGIN on the API deployment to list this
  storefront's origins, since the page now calls the API cross-origin.
{%- endcomment -%}

<script>
  /* Liquid-built so the images come from this theme's assets rather than
     cross-origin from the API host. */
  window.QSC_ASSETS = {
${assets.map(a => `    ${JSON.stringify(a)}: {{ '${a}' | asset_url | json }}`).join(',\n')}
  };
  /* routes.root respects a locale or market prefix; "/cart" would not. */
  window.QSC_CART_URL = {{ routes.cart_url | json }};
</script>

<div id="qsc-app">
${markup}
</div>

<style>
${scopedCss}
</style>

<script>
${js}
</script>

{% schema %}
{
  "name": "Skin consultation",
  "settings": [],
  "presets": [{ "name": "Skin consultation" }]
}
{% endschema %}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, liquid);

/**
 * A second copy under public/, served by the deployment.
 *
 * Shopify's themeFilesUpsert can take a URL and fetch the body itself, which
 * is how the theme gets this file without anyone pasting 70KB into the theme
 * editor. The fetch happens once at upsert time and Shopify stores the result,
 * so the theme does not depend on this copy at runtime — it is a delivery
 * mechanism, not a dependency. `.txt` so it is served as text rather than
 * downloaded.
 *
 * Consequence worth knowing: regenerating means pushing before the theme can
 * be re-synced, because Shopify fetches the deployed copy, not the local one.
 */
const PUBLIC_COPY = resolve('public/analyzer/section.liquid.txt');
writeFileSync(PUBLIC_COPY, liquid);

console.log(`Wrote ${OUT}`);
console.log(`  and  ${PUBLIC_COPY} (for themeFilesUpsert by URL)`);
console.log(`  scoped CSS   ${scopedCss.length.toLocaleString()} bytes`);
console.log(`  script       ${js.length.toLocaleString()} bytes`);
console.log(`  keyframes    ${[...keyframeNames].join(', ')} -> ${KEYFRAME_PREFIX}*`);
console.log(`  assets       ${assets.join(', ')}`);
console.log(`  API          ${API_ORIGIN}/api/skin`);
