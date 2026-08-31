export type MemoryOwner="agent-native"|"repository-instructions"|"context-engine";
export type MemoryClass="personal-preference"|"episodic-task-state"|"workflow-policy"|"repository-fact"|"semantic-relation"|"human-decision";

const OWNERS:Record<MemoryClass,MemoryOwner>={
  "personal-preference":"agent-native",
  "episodic-task-state":"agent-native",
  "workflow-policy":"repository-instructions",
  "repository-fact":"context-engine",
  "semantic-relation":"context-engine",
  "human-decision":"context-engine",
};

export function ownerForMemoryClass(kind:MemoryClass):MemoryOwner { return OWNERS[kind]; }

export function assertMemoryOwnership(kind:MemoryClass,owner:MemoryOwner):void {
  const expected=ownerForMemoryClass(kind);
  if (owner!==expected) throw new Error(`${kind} belongs to ${expected}, not ${owner}`);
}

export function ownershipMatrix():Record<MemoryClass,MemoryOwner> { return {...OWNERS}; }
