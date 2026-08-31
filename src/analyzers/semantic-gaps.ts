/**
 * RCE-008 open semantic gaps.
 *
 * Single source of truth: the characterization suite asserts against it, and the
 * rollout gate counts it. Keeping the ledger in the test alone would let a gate
 * pass while known-wrong analyzer semantics were still shipping.
 */
export const OPEN_SEMANTIC_GAPS=["RCE-008-E"] as const;

/**
 * Gaps that must be closed before a second repository is indexed; a wrong fact
 * travels. `RCE-008-E` (rewrite delegation) is an omission, not a falsehood: the
 * inventory is incomplete but nothing it states is wrong, so it does not block.
 */
export const BLOCKING_SEMANTIC_GAPS=[] as const;
