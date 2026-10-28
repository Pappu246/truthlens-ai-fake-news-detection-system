/**
 * FEVEROUS gold evidence is a list of evidence-group objects, each containing
 * a content array of element IDs. Never treat the group object itself as an ID.
 */
export function hasGoldCandidate(
  goldEvidence: unknown,
  candidateIds: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(goldEvidence) || candidateIds.size === 0) return false;

  return goldEvidence.some((group: unknown) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
    const content = (group as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some((id: unknown) =>
      typeof id === 'string' && candidateIds.has(id)
    );
  });
}
