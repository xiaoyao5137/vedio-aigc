/** The V8 review keeps every original first-frame JPEG and adds four crops
 * from its first image. Crops are native source pixels, never upscaled. */
export const A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL = Object.freeze({
  indices: Object.freeze([0]), columns: 2, rows: 2, overlap: 0.25,
})

/** V9 keeps the identical native-pixel detail contract. */
export const A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL =
  A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL
