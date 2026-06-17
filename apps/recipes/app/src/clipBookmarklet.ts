/**
 * The "Clip Recipe" bookmarklet.
 *
 * Runs in the user's browser on any recipe page. Because it executes in the
 * page's own context (residential IP, real session), site WAFs that 402 our
 * datacenter scraper never see us.
 *
 * It extracts schema.org JSON-LD Recipe objects — the same logic as
 * services/api/src/lib/scraper.ts `extractRecipes`/`isRecipe` and
 * extension-recipes/extract.js: read every <script type="application/ld+json">,
 * JSON.parse it, unwrap @graph, keep items whose @type is/includes "Recipe",
 * default `url` to location.href.
 *
 * It must NOT fetch our API directly — the recipe site's CSP `connect-src`
 * would block a cross-origin request. Instead it hands the payload to our own
 * origin's /import page via the URL **hash** (kept out of server logs), where
 * the user's logged-in session does the actual save.
 *
 * Bulky non-recipe fields (review, aggregateRating, comment) are dropped to
 * keep the URL under length limits.
 *
 * The bookmarklet is a STATIC string with no per-user token — auth happens on
 * the /import page via the existing logged-in session.
 */

const DOMAIN: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DOMAIN) || 'kirkl.in';

export const CLIP_IMPORT_URL = `https://recipes.${DOMAIN}/import`;

// Hand-written, ES5-only, self-contained source. Kept readable here and
// minified into the bookmarklet below. Mirrors extension-recipes/extract.js.
const SOURCE = `
var U=${JSON.stringify(CLIP_IMPORT_URL)};
try{
  var out=[];
  var blocks=document.querySelectorAll('script[type="application/ld+json"]');
  for(var b=0;b<blocks.length;b++){
    var data;
    try{data=JSON.parse(blocks[b].textContent||'');}catch(e){continue;}
    if(data&&typeof data==='object'&&data['@graph'])data=data['@graph'];
    var items=Array.isArray(data)?data:[data];
    for(var i=0;i<items.length;i++){
      var it=items[i];
      if(!it||typeof it!=='object'||!it['@type'])continue;
      var t=it['@type'];var types=Array.isArray(t)?t:[t];
      if(types.indexOf('Recipe')===-1)continue;
      if(!it.url)it.url=location.href;
      delete it.review;delete it.aggregateRating;delete it.comment;
      out.push(it);
    }
  }
  if(!out.length){alert('No recipe found on this page.');return;}
  window.open(U+'#'+encodeURIComponent(JSON.stringify(out)),'_blank');
}catch(e){alert('Clip failed: '+e);}
`;

const minified = SOURCE.replace(/\s*\n\s*/g, '').trim();

export const CLIP_BOOKMARKLET = `javascript:(function(){${minified}})();`;
