import test from 'node:test'
import assert from 'node:assert/strict'
import { isNonSpeechAudioObligation } from '../src/outline-audio-contract.ts'

test('the actual actorless bridge sounds are non-speech audio obligations', () => {
  for (const value of ['城门开启声', '车马声']) {
    assert.equal(isNonSpeechAudioObligation(value), true, value)
  }
})

test('physical sources and their sound-producing actions remain non-speech', () => {
  for (const value of [
    '木门开启声',
    '城门开启的吱呀声',
    '车轮滚动声',
    '远处车马声',
    '马蹄声',
    '水流声',
    '流水声',
    '兵器碰撞声',
    '衣料摩擦声',
    '脚步声',
    '风声',
    '鸟鸣声',
  ]) {
    assert.equal(isNonSpeechAudioObligation(value), true, value)
  }
})

test('complete footstep and object-contact descriptions remain physical effects', () => {
  for (const value of [
    '军士鞋底落在廊道地面的脚步声',
    '士卒靴底踏在石板上的脚步声',
    '行走时陶杯与木盘轻碰的声音',
    '木碗与木案碰撞声',
  ]) assert.equal(isNonSpeechAudioObligation(value), true, value)
  for (const value of [
    '军士说话时鞋底落在廊道地面的脚步声',
    '行走时陶杯与木盘轻碰的声音，严颜说可以坐',
    '两人谈话声与陶杯碰撞声',
    '行动与胜利碰撞的声音',
  ]) assert.equal(isNonSpeechAudioObligation(value), false, value)
})

test('identified water sources and limited distance or level changes remain physical effects', () => {
  for (const value of [
    '河水流动声',
    '溪水流动声',
    '江水声',
    '湖水声',
    '海水声',
    '泉水滴落声',
    '池水流动声',
    '远处马蹄声渐近',
    '远处密集马蹄声',
    '远处隐约的马蹄声逐渐靠近',
    '近处稀疏马蹄声渐远渐弱',
    '河水流动的声音渐强',
    '微弱的风声逐渐增强',
    '响亮的车轮滚动声逐渐减弱',
    '环境声：河水流动声、远处马蹄声渐近',
  ]) {
    assert.equal(isNonSpeechAudioObligation(value), true, value)
  }
})

test('sound changes do not conceal speech, unidentified sources or unrelated actions', () => {
  for (const value of [
    '远处人声渐近',
    '隐约神秘声音渐强',
    '声音逐渐靠近',
    '河水流动声和未知声音',
    '马蹄声渐近，骑兵喊停下',
    '环境声：河水流动声，旁白解释敌军将至',
    '远处马蹄声渐近，张飞说“来了”',
    '河水声渐强后张飞转身',
    '马蹄声使敌军犹豫',
  ]) {
    assert.equal(isNonSpeechAudioObligation(value), false, value)
  }
})

test('explicit sound-design labels and lists do not invent speech', () => {
  for (const value of [
    '音效：城门开启声',
    '环境声：车马声',
    '城门开启声、车马声',
    '水流声与兵器碰撞声',
    '  城门开启声  ',
  ]) {
    assert.equal(isNonSpeechAudioObligation(value), true, value)
  }
})

test('unknown sound descriptions retain the conservative speech path', () => {
  for (const value of ['神秘声音', '人声', '同期声', '声音', '声响', '远处的歌声']) {
    assert.equal(isNonSpeechAudioObligation(value), false, value)
  }
})

test('narration, dialogue and quoted words override a physical sound mention', () => {
  for (const value of [
    '旁白：洛阳城门已经开启，官员车马进出。',
    '画外音：他听到了车马声。',
    '解说：这是洛阳城门开启声。',
    '对白：城门开启声',
    '张角：我听见了车马声。',
    '台词：风声',
    '“城门开启声”',
    '张角说出城门开启声',
    '百姓听见车马声后聚集',
  ]) {
    assert.equal(isNonSpeechAudioObligation(value), false, value)
  }
})

test('sound labels cannot conceal lexical speech mixed into the obligation', () => {
  for (const value of [
    '音效：城门开启声；张角说：开门！',
    '环境声：旁白说洛阳城门已经开启',
    '音效：车马声，百姓说“我们来了”',
    '城门开启声和张角说话声',
    '环境声：城门开启声、张角：善道可救天下',
  ]) {
    assert.equal(isNonSpeechAudioObligation(value), false, value)
  }
})

test('missing or malformed obligations never count as proven non-speech', () => {
  for (const value of [undefined, null, '', '  ', 0, true, [], ['车马声'], { text: '车马声' }]) {
    assert.equal(isNonSpeechAudioObligation(value), false, JSON.stringify(value))
  }
})
