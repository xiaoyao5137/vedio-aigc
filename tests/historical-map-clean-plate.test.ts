import test from 'node:test'
import assert from 'node:assert/strict'
import { assertHistoricalMapCleanPlatePrompt } from '../server/historical-map-clean-plate.ts'

test('supplier clean-map prompts allow geography motion and local postproduction, while rejecting baked visual marks', () => {
  const allowed = [
    '古代山川与城址保持朝向，镜头缓慢推移。地图底片不得绘制路线、文字或肖像。',
    '只生成无字无人的历史地理裸底图；地名与箭头由本地后期图层叠加。',
    '水系连续，山脉在原位置；人物静态图由系统后期叠加。',
  ]
  for (const prompt of allowed) assert.doesNotThrow(() => assertHistoricalMapCleanPlatePrompt(prompt), prompt)
  const forbidden = [
    '在地图上画出红蓝两条行军路线。',
    '红色箭头从北向南逐渐显现。',
    '在城旁标注“当阳方”。',
    '地图右上角写上长坂地名。',
    '让张飞肖像在地图左侧淡入。',
    '首帧保持无字，尾帧显示军队路线。',
  ]
  for (const prompt of forbidden) assert.throws(() => assertHistoricalMapCleanPlatePrompt(prompt),
    /HISTORICAL_MAP_PLATE_PROMPT_CONFLICT/, prompt)
})
