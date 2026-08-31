const TURKISH_ASCII:Record<string,string>={
  "ç":"c","Ç":"C","ğ":"g","Ğ":"G","ı":"i","İ":"I","ö":"o","Ö":"O","ş":"s","Ş":"S","ü":"u","Ü":"U",
};

/**
 * User-facing route aliases are compared accent-insensitively without changing
 * the route stored from the repository. Exact and Unicode route spellings can
 * therefore coexist and are returned as separate matches when both are real.
 */
export function routeLookupKey(value:string):string {
  let decoded=value.trim();
  try { decoded=decodeURIComponent(decoded); } catch { /* Keep malformed input inspectable rather than throwing. */ }
  const folded=[...decoded].map((character)=>TURKISH_ASCII[character] ?? character).join("")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  if (folded==="/") return folded;
  return folded.replace(/\/+$/g,"");
}

export function routesEquivalent(left:string,right:string):boolean {
  return left===right||routeLookupKey(left)===routeLookupKey(right);
}
