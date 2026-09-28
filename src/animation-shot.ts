export const ANIMATION_STYLES = [
  'historical_map',
  'character_illustration',
  'historical_tableau',
  'symbolic_transition',
  'time_montage',
  'environment_transition',
] as const

export const ANIMATION_AESTHETICS = [
  'historical_cartography',
  'physical_sand_table',
  'cinematic_gongbi',
  'ink_wash',
  'woodblock_print',
  'shadow_puppet',
  'painterly_2d',
] as const

export type AnimationStyle = typeof ANIMATION_STYLES[number]
export type AnimationAesthetic = typeof ANIMATION_AESTHETICS[number]

const LEGACY_STYLE: Record<string, AnimationStyle> = {
  animated_map: 'historical_map',
  historical_montage: 'historical_tableau',
}

export function isAnimatedVisualTreatment(value: unknown) {
  return ['animated', 'animated_map', 'historical_montage'].includes(String(value ?? ''))
}

export function resolvedAnimationStyle(visualTreatment: unknown, animationStyle: unknown): AnimationStyle | '' {
  const declared = String(animationStyle ?? '')
  if ((ANIMATION_STYLES as readonly string[]).includes(declared)) return declared as AnimationStyle
  return LEGACY_STYLE[String(visualTreatment ?? '')] ?? ''
}

export function animationStyleAllowsEmptyCast(style: unknown) {
  return ['historical_map', 'historical_tableau', 'symbolic_transition', 'time_montage', 'environment_transition']
    .includes(String(style ?? ''))
}

/** People rendered as paintings use deterministic 2D layer motion. Their whole
 * cards may move, scale or fade, while the artwork inside never articulates. */
export function isStaticIllustrationStyle(visualTreatment: unknown, animationStyle: unknown) {
  const style = resolvedAnimationStyle(visualTreatment, animationStyle)
  return style === 'character_illustration' || style === 'historical_tableau'
}

export const ANIMATION_STYLE_PROMPT = `animationStyle 只描述动画承担的叙事方法，枚举如下：
- historical_map：有史料依据的古代历史地理地图，表现疆域、山川、城址、路线、势力或空间关系变化；可在地图上叠加一至两幅静态具名人物肖像，不把地图当作默认转场。
- character_illustration：静态历史人物素材的二维编排，只用画外旁白介绍人物或背景；人物素材内部姿态、表情和嘴部全程锁定，但整个人物图层可淡入、平移、缩放、淡出，并按叙事关系放在合适的历史背景上。
- historical_tableau：定格历史场景插画，由画外旁白讲清史实背景；画中人物和物件不自行活动，允许整幅画轻微缩放、平移或渐变转场。
- symbolic_transition：用印玺、竹简、火焰、雨水、兵器等同一视觉母题做动作或形状匹配转场。
- time_montage：用连续意象表现时间流逝、局势累积或因果推进。
- environment_transition：用昼夜、季节、天气、城市/营寨环境变化完成时空衔接。
animationAesthetic 只描述统一美术语言，三国 historical_map 镜头使用 historical_cartography（古代历史地理地图的二维绘图与设色）。其他可用美术语言有 cinematic_gongbi（电影工笔）、ink_wash（水墨写意）、woodblock_print（木刻版画）、shadow_puppet（皮影剪影）、painterly_2d（二维厚涂插画）。同一镜只选一个 animationStyle 和一个 animationAesthetic。人物插画不是低幼卡通，不使用现代动漫符号、游戏CG、Q版比例或玄幻光效。地图信息镜头中的静态人物肖像与 character_illustration 一样由系统按 illustrationLayers 编排，不让视频模型生成人物肢体运动；地图之外的人物正戏仍用真人实景。`
