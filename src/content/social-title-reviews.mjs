// Human-reviewed translations. Each entry must match jobId, contentHash and
// sourceTitle so a later source edit cannot silently reuse an old approval.
// Shape: { jobId, contentHash, sourceTitle, title } (all strings).
// Review the source before adding an English title. Do not invent seniority,
// technology, or English-language eligibility. After deploying an approval,
// explicitly reset the held bridge and enabled social stages using retry-stage;
// never reset a published stage. Holds appear as social_title_review_required.
export const SOCIAL_TITLE_REVIEWS = Object.freeze([]);
