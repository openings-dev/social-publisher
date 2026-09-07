// Preview and production deliberately use the same template.
export {
  ARTWORK_STYLES as CONCEPT_STYLES,
  ARTWORK_ROTATION as CONCEPT_ROTATION,
  ARTWORK_FORMATS as CONCEPT_FORMATS,
  createArtworkSvg as createConceptPosterSvg,
} from '../render/job-poster.mjs';
