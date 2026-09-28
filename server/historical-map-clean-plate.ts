/** Keep authored geography motion but reject old positive instructions to bake
 * labels, routes or portraits into a paid supplier map plate. */
export function assertHistoricalMapCleanPlatePrompt(prompt: string): void {
  const positiveMarks = /(?:画出|绘制|标注|标出|标记|标明|写上|题写|显示|出现|呈现|浮现|渐显|显现|亮起|勾勒|绘出|演示|移动|推进|延伸|加入|叠加|摆放)[^。；，,\n]{0,20}(?:路线|箭头|地名|文字|字幕|肖像|头像|人物卡片|行军轨迹)|(?:路线|箭头|地名|文字|字幕|肖像|头像|人物卡片|行军轨迹)[^。；，,\n]{0,20}(?:渐显|出现|浮现|显示|标注|变化|推进|延伸|淡入|淡出|叠加|加入|展示|表示)|(?:标注|标出|标记|标明|写上|题写)(?:“[^”]{1,20}”|「[^」]{1,20}」|[\p{Script=Han}]{2,8})/u
  for (const clause of prompt.split(/[。；，,\n]|但是|然而|不过|同时|并且|但|而|却/)) {
    const match = positiveMarks.exec(clause)
    const preceding = match ? clause.slice(0, match.index).trimEnd() : ''
    const localScope = match ? clause.slice(Math.max(0, match.index - 16), match.index + match[0].length + 6) : ''
    // A prohibition can govern an entire enumeration: “不得烘焙文字、路线、头像”.
    // Only text before the positive-looking phrase can negate it, so a later
    // “不得画人物” cannot excuse an earlier request to draw a route.
    if (match && !/(?:禁止|不得|绝不|不烘焙|均不烘焙|不画|不生成|不添加|不绘制|不显示|不出现|不标注|不增|不要|不应|不能|不准|严禁|避免)/.test(preceding)
      && !/(?:本地|系统|批准)[^。]{0,10}(?:后期|图层)|(?:本地|系统)后期|后期图层/.test(localScope)) {
      throw Error(`HISTORICAL_MAP_PLATE_PROMPT_CONFLICT: 供应商地图底片仍要求绘制路线、文字或肖像：${clause.trim().slice(0, 80)}`)
    }
  }
}
