import { SCENE_CUT_CROSS_THRESHOLD_IMAGE_ADDENDUM, SCENE_CUT_FIRST_FRAME_PROMPT } from './scene-cut-first-frame-gate.ts'

/** Keep the full approved shot in the signed request params, while the still
 * model sees the zero-second projection instead of a conflicting final pose. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V195 = SCENE_CUT_FIRST_FRAME_PROMPT
  .replace('${shot_script.visualPrompt}',
    '${scene_cut_opening_state.openingVisualContext.staticScene}')
  .replace('${shot_script.pacing.beats}',
    '${scene_cut_opening_state.requiredVisualActions}')
  + '\n【腕圈与全身可见性】若本镜后续要收紧腕绳，首帧在双腕周围画一圈明显过大的开放绳圈，绳与腕之间保留可见背景，绳圈与操作者手中的外段分别可辨；不得画贴腕的绕缠。若本镜后续要站稳挺直，衣摆与双腿错开，让屈膝轮廓可见。参与押送者横向错位，每人的双脚、脚跟及接地边缘均不被衣摆或他人遮挡。'

export const SCENE_CUT_FIRST_FRAME_PROMPT_V197 = SCENE_CUT_FIRST_FRAME_PROMPT_V195
  + SCENE_CUT_CROSS_THRESHOLD_IMAGE_ADDENDUM
