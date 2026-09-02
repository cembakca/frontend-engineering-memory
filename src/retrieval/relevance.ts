/**
 * Query-side lexical relevance.
 *
 * Ranking used to carry no query-dependent feature at all: task fit, relation
 * coverage, freshness, evidence quality and entity specificity are identical
 * for every route in a repository, so a route lookup was decided by
 * `channelRelevance` alone — which the SQL channel filled with alphabetical
 * order. This module gives both the SQL channel and the ranker one shared,
 * explainable measure of "does this candidate answer *this* question".
 */

function normalize(value:string):string {
  return value.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replaceAll("ı","i").replaceAll("ş","s").replaceAll("ğ","g").replaceAll("ç","c").replaceAll("ö","o").replaceAll("ü","u");
}

/**
 * Path separators *and* camel-case boundaries split tokens:
 * `src/components/ContactForm.tsx` → components, contact, form. Lowercasing
 * first would fuse `ContactForm` into one token that the word "form" can never
 * match, which is how identifiers hide from the query that names them.
 */
export function relevanceTokens(value:string):string[] {
  return normalize(value.replace(/([a-z0-9])([A-Z])/g,"$1 $2")).match(/[a-z0-9]{2,}/g) ?? [];
}

/** Turkish/English question scaffolding carries no retrieval signal. */
const STOPWORDS=new Set([
  "hangi","hangisi","nedir","nerede","nereden","nasil","neden","ne","kim","kac","mi","mu","mus",
  "ve","veya","ile","icin","gibi","daha","bir","bu","su","o","da","de","ki","ise","ya",
  "var","yok","olan","oluyor","yapiyor","gelir","gelen","kullanilir","kullaniyor","calisir",
  "the","a","an","and","or","of","in","on","for","to","is","are","does","do","what","which","where","how","why",
]);

/**
 * Turkish is agglutinative: `dosyasindadir` and `dosya` are the same term for
 * retrieval purposes. Equality is therefore prefix-tolerant, with a length
 * floor so that short fragments cannot match everything.
 */
function matches(term:string,candidate:string):boolean {
  if (term===candidate) return true;
  const shorter=term.length<=candidate.length ? term : candidate;
  const longer=term.length<=candidate.length ? candidate : term;
  return shorter.length>=4&&longer.startsWith(shorter);
}

export function queryTerms(raw:string):Set<string> {
  return new Set(relevanceTokens(raw).filter((term)=>term.length>=3&&!STOPWORDS.has(term)));
}

function hitRatio(terms:Set<string>,candidates:string[]):number {
  if (!terms.size||!candidates.length) return 0;
  let hits=0;
  for (const term of terms) if (candidates.some((candidate)=>matches(term,candidate))) hits+=1;
  return hits/terms.size;
}

/**
 * Identity (subject and file path) is worth more than prose: a route named by
 * the question is a stronger answer than a memory that merely mentions it.
 * Returns a neutral .5 when the caller supplied no query terms, so callers that
 * do not have a query keep their previous relative ordering.
 */
export function relevanceScore(terms:Set<string>,target:{subject?:string|null;sourceFile?:string|null;content?:string|null}):number {
  if (!terms.size) return .5;
  const identity=[...relevanceTokens(target.subject ?? ""),...relevanceTokens(target.sourceFile ?? "")];
  // Long facts would otherwise match nearly every term by sheer length.
  const content=relevanceTokens(String(target.content ?? "").slice(0,600));
  return Math.max(0,Math.min(1,hitRatio(terms,identity)*.75+hitRatio(terms,content)*.25));
}
